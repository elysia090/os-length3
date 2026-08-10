"""Entry points for the browser worker.

The worker cannot call Python objects across the boundary cheaply, so this
module exposes a few JSON-in / JSON-out functions and keeps every decision on
the Python side:

    route(source)             is this C, or is it already a listing?
    prepare(source)           the source as Clang should see it
    plan(source, options)     what to compile, and which inputs to evaluate
    finish(source, options)   the full result, given the evaluated table

The split exists because the *evaluation* is the one step that must not happen
in Python: `web/worker.js` compiles the paste with clang.wasm, instantiates the
wasm32 module and calls the exported function over the domain at native speed.
Everything else — quotients, synthesis, lowering, verification — runs here.
"""

import json
import base64

from .cfront import CFrontError, NoEntry
from .clang import read_signature
from .frontend import list_frontends
from .pipeline import solve, to_json_safe
from .semantics import choose_domain
from .version import version_block


def _dumps(payload):
    return json.dumps(payload, default=str)


def capabilities():
    """What this build can do, for the UI to render before anything is run."""
    from .isa import PROFILES
    return _dumps({
        'versions': version_block(),
        'frontends': list_frontends(),
        'targets': [p.to_dict() for p in PROFILES],
        'observers': [
            {'spec': 'exact', 'label': 'Exact output'},
            {'spec': 'low:8', 'label': 'Observe low 8 bits'},
            {'spec': 'low:16', 'label': 'Observe low 16 bits'},
            {'spec': 'high:8', 'label': 'Observe HIGH bits only'},
            {'spec': 'nonzero', 'label': 'Observe zero/nonzero'},
            {'spec': 'mask:0xFF00FF00FF00FF00', 'label': 'Custom bit mask'},
        ],
    })


def route(source):
    """Is this paste C, or is it already a listing?

    The worker asks before it starts a compiler.  Handing assembly to Clang
    produces a page of parse errors about a file that was never C, so the
    decision belongs here, next to the reader that will do the work.
    """
    from . import asmfront
    dialect = asmfront.detect(source or '')
    return _dumps({'kind': 'asm' if dialect else 'c', 'dialect': dialect})


def split(source):
    """The paste without its driver, and whether it had one.

    A paste may carry a `main` that exercises the kernel. Two different things
    want two different halves of it: the minimizer must see the kernel alone —
    `main` reads a stream, not a domain, and minimizing it would report the
    driver's function — while running the paste needs the whole file. The page
    asks once, here, so both halves come from one decision.
    """
    from .clang import split_main
    kernel, span = split_main(source or '')
    return _dumps({'ok': True, 'has_main': span is not None,
                   'kernel': kernel})


def prepare(source):
    """The paste as Clang should see it — the one place that decides.

    The browser used to hand its raw text straight to clang.wasm, which meant
    the freestanding prelude and the intrinsic definitions in `clang.py` were
    applied on the native path and nowhere else.  `#include <immintrin.h>`
    then reached a wasm32 compile, where it declares nothing, and QM's own
    emitted `_pdep_u64` came back as an undeclared function.
    """
    from .clang import prepare_source
    return prepare_source(source or '')


def prepare_run(source):
    """The driver unit, with the selected kernel undefined for the artifact.

    Compiling the whole paste would run Clang's kernel and call that the
    answer. What Run has to execute is the minimized program, so only that
    function arrives as an import and `web/worker.js` implements it by feeding
    the artifact. `main`, globals, and unrelated helper definitions remain.
    """
    from .clang import prepare_driver, split_main
    source = source or ''
    kernel, _span = split_main(source)
    try:
        signature = read_signature(kernel)
    except CFrontError:
        signature = None
    return prepare_driver(source, signature)


def prepare_state(source):
    """Compile the complete C unit for whole-program wasm state extraction.

    Unlike ``prepare_run``, no function is replaced by an import.  The scalar
    kernel artifact is already verified separately; this compile supplies the
    control stack, globals and memory that make ``main`` a state machine.
    """
    from .clang import prepare_driver
    return prepare_driver(source or '', None)


def stateful_wasm(encoded, function='main', options_json='{}'):
    """Decode linked wasm and close its imported-byte state machine exactly."""
    from .transducer import StateLimit
    from .wasmstate import compile_stream, decode_module
    from .wasmwave import WaveExecutor

    options = json.loads(options_json or '{}')
    max_states = int(options.get('state_max_states', 4096))
    budget = int(options.get('state_step_budget', 1 << 20))
    try:
        raw = base64.b64decode(encoded, validate=True)
        module = decode_module(raw)
        index = module.export(function)
        entry_type = module.types[module.functions[index].type_index]
        # Clang gives C `main` its conventional argc/argv wasm ABI even when
        # the source spells `main(void)`. JavaScript invocation supplies zero
        # for omitted integer parameters; the state frontend must start from
        # the same concrete machine state rather than reject that ABI wrapper.
        args = tuple(0 for _ in entry_type.params)
        executor = WaveExecutor(module)
        compiled = compile_stream(module, function,
                                  max_states=max_states, budget=budget,
                                  args=args, executor=executor)
        report = compiled.to_dict()
        report.update({
            'ok': True,
            'exact': True,
            'function': function,
            'input_alphabet': 'byte + EOF',
            'state_bits': max(0, (compiled.classes - 1).bit_length()),
            'initial_observation': compiled.out(compiled.initial),
            'execution_layout': executor.total_cost.layout(),
            'ordered_barriers': [
                'load', 'store', 'call', 'branch', 'control',
                'global', 'memory',
            ],
            'runtime': ('quotient data is a build witness; execution retains '
                        'the selected wasm/codec machine'),
        })
        return _dumps(report)
    except StateLimit as exc:
        return _dumps({
            'ok': False,
            'exact': False,
            'stage': 'state-closure',
            'error': {'message': str(exc),
                      'hint': 'raise state_max_states or reduce explicit state'},
        })
    except (CFrontError, ValueError) as exc:
        detail = exc.to_dict() if isinstance(exc, CFrontError) else {
            'message': str(exc)}
        return _dumps({'ok': False, 'exact': False,
                       'stage': 'state-frontend', 'error': detail})


def run_plan():
    """What the driver's kernel import has to be wired to.

    From the last solve, so it names the function QM actually took rather than
    whatever the paste happens to define first.
    """
    if '*artifact' not in _LAST:
        return _dumps({'ok': False,
                       'error': _LAST.get('*artifact_error')
                       or 'no minimized program has been built yet'})
    function = _LAST.get('*function') or 'kernel'
    parameters = _LAST.get('*parameter_layout') or []
    from .clang import driver_import_name
    return _dumps({'ok': True,
                   'function': function,
                   'import_function': driver_import_name(
                       function, len(parameters) or 1),
                   'parameters': parameters,
                   'input_bits': _LAST['*input_bits'],
                   'output_bits': _LAST['*output_bits'],
                   'in_bytes': -(-_LAST['*input_bits'] // 8),
                   'out_bytes': -(-_LAST['*output_bits'] // 8)})


def plan(source, options_json='{}'):
    """Decide the signature and the input domain before compiling.

    Returning the domain explicitly is what lets the worker evaluate exactly the
    inputs QM will verify against — no more, and never fewer.
    """
    options = json.loads(options_json or '{}')
    try:
        signature = read_signature(source, options.get('function'))
    except NoEntry as exc:
        return _dumps({'ok': False, 'idle': True,
                       'error': exc.to_dict()})
    except CFrontError as exc:
        return _dumps({'ok': False, 'error': exc.to_dict()})

    from .frontend import parameter_layout, require_analysable
    try:
        require_analysable(signature)
    except CFrontError as exc:
        return _dumps({'ok': False, 'error': exc.to_dict()})

    ret = signature['ret']
    parameters = parameter_layout(signature['params'])
    input_bits = min(sum(item['bits'] for item in parameters),
                     int(options.get('max_input_bits', 64)))
    if options.get('input_bits'):
        input_bits = int(options['input_bits'])
    domain = choose_domain(
        input_bits,
        exhaustive_limit=int(options.get('exhaustive_limit', 16)),
        probes=int(options.get('probes', 4096)),
    )

    return _dumps({
        'ok': True,
        'function': signature['name'],
        'signature_via': signature.get('via'),
        'param_type': (parameters[0]['type'] if len(parameters) == 1
                       else None),
        'parameters': parameters,
        'return_type': ret.name,
        'input_bits': input_bits,
        'output_bits': ret.bits,
        'domain': domain.to_dict(),
        # Which other functions the paste defined, and why each was not taken.
        # Only this side ever parses the source, so if it does not travel the
        # browser cannot say which of twenty kernels it answered about.
        'other_functions': signature.get('others') or [],
        # Decimal strings, for the same reason the outputs come back as
        # strings: a JSON number is a double, and 4,177 of the 4,287 points in
        # a 64-bit domain are above 2^53.  Sent as numbers they arrive rounded,
        # and the worker would evaluate the kernel at inputs neither side
        # asked for.
        'values': [str(v) for v in domain.values()],
        'signature': {
            'name': signature['name'],
            'signature': '%s %s(%s)' % (
                ret.name, signature['name'],
                ', '.join('%s %s' % (item['type'], item['name'])
                          for item in parameters)),
            'return': ret.to_dict(),
            'params': [
                {'name': name, 'type': ctype.to_dict()}
                for name, ctype in signature['params']
            ],
        },
    })


# The last solve, before `to_json_safe` strips it.  A lowered `Seq` is a live
# object and cannot cross to JS, so the one place that can still run the
# minimized program is here, in the worker that produced it.
_LAST = {}


CODEC_TARGET = 'codec'

# Above this the C view is replaced by a note; see where it is used.
C_RENDER_LIMIT = 20000


def _codec_cost(picture, input_bits):
    """Physical row-wave cost of this image, worst of a fixed sample.

    Span and work are properties of the *run*, not of the listing. A transition
    is one capture plus a broadcast over the rows that read the written
    coordinate, costing `Theta(k+1)` work and `Theta(1)` dependency span.
    Counting instructions instead — which is what this used to do — reports the
    same number for span and for work and is neither of them.

    A run is input-dependent, so this takes the worst of a small fixed sample
    rather than claiming a single number covers every input. Three values are
    enough to be worth reporting and cheap enough to always do: across the
    examples here, all-zeros, alternating and all-ones bracket a five-value
    sample to within one percent, and the largest image costs about a second.
    """
    from vm import machine, rows

    limit = (1 << input_bits) - 1
    values = sorted({0, 0xAAAAAAAAAAAAAAAA & limit, limit})
    width = -(-input_bits // 8)
    # This lowering is straight-line, so a terminating run enters each
    # instruction about once; eight times the cell count is generous headroom
    # and still bounds a runaway at a few seconds rather than a hang.
    budget = max(1 << 16, 8 * len(picture.memory))

    residual = machine.Residual(picture)
    worst = None
    for value in values:
        history = [(value >> (8 * i)) & 255 for i in range(width)]
        try:
            cost = rows.measure(residual, history, budget)
        except machine.Unfinished:
            return None
        if cost is None:
            return None
        if worst is None or cost.work > worst.work:
            worst = cost
    return worst


def _keep(result):
    """Remember the solve, and add the codec to the targets it can be seen as.

    The codec compiler consumes the minimized wasm32 sequence. This keeps the
    browser path linear: C is compiled to wasm32 for evaluation, QM produces a
    smaller wasm32 program, and that program is encoded for the VM.
    """
    _LAST.clear()
    if not result.get('ok') or not result.get('program'):
        return result

    _LAST['*input_bits'] = result['frontend']['input_bits']
    _LAST['*output_bits'] = result['frontend']['output_bits']
    _LAST['*primary'] = result.get('primary_target')
    _LAST['*function'] = (result['frontend'].get('function') or {}).get('name')
    _LAST['*parameter_layout'] = (
        result['frontend'].get('parameter_layout') or [])

    from vm import codec as vm_codec, emit, image as vm_image, lower

    input_bits, output_bits = _LAST['*input_bits'], _LAST['*output_bits']
    wasm = next((target for target in result.get('targets') or []
                 if target.get('name') == 'wasm32' and target.get('ok')
                 and target.get('seq') is not None), None)
    if wasm is None:
        _LAST['*artifact_error'] = 'no minimized wasm32 program was produced'
        return result
    try:
        picture = lower.lower_seq(wasm['seq'], input_bits, output_bits)
    except lower.Unsupported as exc:
        _LAST['*artifact_error'] = str(exc)
        return result

    payload = vm_image.serialize(picture)
    blob = vm_codec.pack(vm_codec.code(payload))
    _LAST['*artifact'] = blob
    _LAST['*image'] = picture
    _LAST['*physical_sources'] = {
        target['name']: target['seq']
        for target in result.get('targets') or []
        if target.get('ok') and target.get('seq') is not None
    }
    _LAST['*physical_codecs'] = {}

    name = (result['frontend'].get('function') or {}).get('name') or 'kernel'
    primary = next((t for t in result.get('targets') or []
                    if t['name'] == result.get('primary_target')), None)
    cost = _codec_cost(picture, input_bits)
    if cost is None:
        # No run finished inside the budget, so there is no physical run cost to
        # report. Say the size of the image and say that is what it is.
        steps = sum(1 for at in picture.memory if at >= 0) // 3
        span, work = steps, steps
        note = 'the artifact itself; %d instructions, not run' % steps
    else:
        span, work = cost.span, cost.work
        note = ('the artifact itself; %s transitions, %s of them quiet'
                % ('{:,}'.format(cost.transitions), '{:,}'.format(cost.quiet)))

    result.setdefault('targets', []).append({
        'name': CODEC_TARGET,
        'isa': {'name': CODEC_TARGET, 'title': 'codec', 'note': note},
        'ok': True,
        # This describes the row wave, not the listing: one transition is a
        # dependency is Theta(1), and a wave over the rows that read the cell
        # it wrote, which is Theta(k+1) work. Span and work therefore differ,
        # and neither is the instruction count.
        'span': span,
        'work': work,
        # Span is one per transition, so it already says how many there were.
        'quiet': cost.quiet if cost else None,
        'barriers': cost.barriers if cost else None,
        'core_ops': (result.get('program') or {}).get('core_ops'),
        # One row is entered and repaired; these numbers count that physical
        # shape while `machine.py` remains the transition semantics.
        'instructions': ['ROW'],
        'L_bits': vm_codec.length(payload),
        'L_bytes': len(blob),
        'cells': len(picture.memory),
        # The codec view is the codeword — `pack(code(z))` as bytes, with its
        # fields named — and then the listing those bits decode to. A view
        # called codec that showed only a disassembly would be showing the
        # decode and calling it the code.
        'asm': emit.emit_code(picture, name, input_bits, output_bits,
                              listing=len(picture.memory) <= C_RENDER_LIMIT),
        # The C rendering of a big image is a file of the same order as the
        # image, and it crosses the worker boundary as one string.  Past this
        # it is offered rather than sent; the listing above is the artifact
        # either way.
        'c': (emit.emit_c(picture, '%s_qm' % name, input_bits, output_bits)
              if len(picture.memory) <= C_RENDER_LIMIT else
              '/* %d cells: too large to render as C here.\n'
              '   The listing beside it is the same program. */\n'
              % len(picture.memory)),
        'verification': primary.get('verification') if primary else None,
        'observer': primary.get('observer') if primary else None,
        'representatives': [('artifact', 'pack(code(z))')],
    })
    return result


def artifact(_target_name=''):
    """The minimized program as one rSUBLEQ artifact.

    There is one, not one per target: `_keep` builds it from the minimized
    wasm32 sequence. The argument is accepted and ignored so a
    caller that names the target it is looking at still gets the program.

    Base64 because the artifact is bytes and JSON has no way to say so.
    """
    import base64

    if '*artifact' not in _LAST:
        if '*artifact_error' in _LAST:
            return _dumps({'ok': False,
                           'error': 'this program has no artifact: %s'
                                    % _LAST['*artifact_error']})
        return _dumps({'ok': False,
                       'error': 'no minimized program has been built yet'})

    blob = _LAST['*artifact']
    input_bits, output_bits = _LAST['*input_bits'], _LAST['*output_bits']
    return _dumps({
        'ok': True,
        'target': CODEC_TARGET,
        'artifact': base64.b64encode(blob).decode('ascii'),
        'bytes': len(blob),
        'input_bits': input_bits,
        'output_bits': output_bits,
        'in_bytes': -(-input_bits // 8),
        'out_bytes': -(-output_bits // 8),
    })


def physical_codec(_target_name=''):
    """The disposable span/work execution cache for the minimized program.

    This is separate from :func:`artifact`: the canonical rSUBLEQ code remains
    the program identity, while this target-shaped page can be loaded on
    demand, dropped, or rebuilt from the same solved sequence.
    """
    import base64

    from . import scalarpage

    sources = _LAST.get('*physical_sources') or {}
    target_name = _target_name or 'wasm32'
    seq = sources.get(target_name)
    if seq is None:
        return _dumps({'ok': False,
                       'error': 'no physical execution cache for %s'
                                % target_name})
    cache = _LAST['*physical_codecs']
    if target_name not in cache:
        blob = scalarpage.pack(seq)
        cache[target_name] = (blob, scalarpage.unpack(blob).layout())
    blob, layout = cache[target_name]
    return _dumps({
        'ok': True,
        'format': 'scalar-page',
        'target': target_name,
        'codec': base64.b64encode(blob).decode('ascii'),
        'bytes': len(blob),
        'layout': layout,
    })


def normalize_wasm(encoded):
    """Apply safe function-local QM to a compiled wasm module.

    Improving closed scalar bodies may be rewritten. Straight-line state bodies
    are audited through the physical state-step route, but their typed-Wasm
    bodies remain intact; calls, host observations, traps, atomics, and
    observable control boundaries are not rewritten.
    """
    import base64

    from .wasmbinary import optimize_module

    try:
        raw = base64.b64decode(encoded, validate=True)
        optimized, report = optimize_module(raw)
    except (ValueError, TypeError, CFrontError) as error:
        return _dumps({'ok': False, 'error': str(error)})
    return _dumps({
        'ok': True,
        'wasm': base64.b64encode(optimized).decode('ascii'),
        'module_bytes': report['module_bytes'],
        'output_bytes': report['output_bytes'],
        'pure_integer_slices': report['decoded_pure_integer_expressions'],
        'physical_work': report['physical_work'],
        'physical_span': report['physical_span_sum'],
        'parallel_slices': report['parallel_slices'],
        'max_wave_width': report['max_wave_width'],
        'replaced': report['replaced'],
        'saved_body_bytes': report['saved_body_bytes'],
    })


def parse_input(value='0'):
    """One input value, or why it is not one. Decimal or 0x, and it must fit."""
    from .bits import mask_of
    if '*input_bits' not in _LAST:
        return _dumps({'ok': False,
                       'error': 'no minimized program has been built yet'})
    input_bits = _LAST['*input_bits']
    try:
        x = int(str(value).strip() or '0', 0)
    except ValueError:
        return _dumps({'ok': False, 'error': 'not an integer: %r' % value})
    if not 0 <= x <= mask_of(input_bits):
        return _dumps({'ok': False,
                       'error': 'input does not fit %d bits' % input_bits})
    # Little-endian, which is the order `lower_seq` frames the stream in.
    return _dumps({'ok': True, 'value': str(x), 'input_bits': input_bits,
                   'feed': [(x >> (8 * k)) & 0xFF
                            for k in range(-(-input_bits // 8))]})


def evaluate(target_name='', value='0'):
    """Run the minimized program on one input, through the artifact.

    The reference path: normalize, then `open`/`feed`/`read` on the Python
    machine. `web/vm.js` does the same thing on the compiled one, and
    `tests/test_vm_qm.py` requires the two to agree.
    """
    import base64
    from vm.run import evaluate as run_artifact

    parsed = json.loads(parse_input(value))
    if not parsed['ok']:
        return _dumps(parsed)
    built = json.loads(artifact(target_name))
    if not built['ok']:
        return _dumps(built)

    blob = base64.b64decode(built['artifact'])
    out = run_artifact(blob, int(parsed['value']),
                       built['input_bits'], built['output_bits'])
    if out is None:
        return _dumps({'ok': False,
                       'error': 'the artifact gave no byte for this input'})
    return _dumps({'ok': True, 'input': parsed['value'],
                   'input_bits': built['input_bits'],
                   'output': str(out), 'target': built['target'],
                   'artifact_bytes': built['bytes']})


def finish(source, options_json='{}', table=None, assembly=''):
    """Run the pipeline on a table the worker has already evaluated."""
    options = json.loads(options_json or '{}')
    options = dict(options)
    options['table'] = list(table or [])
    options['assembly'] = assembly or ''
    result = _keep(solve(source, function=options.get('function'),
                         observer=options.get('observer', 'exact'),
                         targets=options.get('targets'),
                         frontend='precompiled', options=options))
    return _dumps(to_json_safe(result))


def fallback(source, options_json='{}'):
    """Run the whole pipeline in Python, with no compiler involved.

    Two things land here: C, when the Clang bundle cannot be fetched — slower
    and limited to the subset, but the page still answers — and any paste
    `route` identified as a listing, which never needed a compiler at all.
    """
    options = json.loads(options_json or '{}')
    result = _keep(solve(source, function=options.get('function'),
                         observer=options.get('observer', 'exact'),
                         targets=options.get('targets'),
                         frontend='cfront', options=options))
    return _dumps(to_json_safe(result))
