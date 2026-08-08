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

from .cfront import CFrontError
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


def plan(source, options_json='{}'):
    """Decide the signature and the input domain before compiling.

    Returning the domain explicitly is what lets the worker evaluate exactly the
    inputs QM will verify against — no more, and never fewer.
    """
    options = json.loads(options_json or '{}')
    try:
        signature = read_signature(source, options.get('function'))
    except CFrontError as exc:
        return _dumps({'ok': False, 'error': exc.to_dict()})

    from .frontend import require_analysable
    try:
        require_analysable(signature)
    except CFrontError as exc:
        return _dumps({'ok': False, 'error': exc.to_dict()})

    param_name, param_ctype = signature['params'][0]
    ret = signature['ret']

    input_bits = min(param_ctype.bits, int(options.get('max_input_bits', 64)))
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
        'param_type': param_ctype.name,
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
            'signature': '%s %s(%s %s)' % (ret.name, signature['name'],
                                           param_ctype.name, param_name),
            'return': ret.to_dict(),
            'params': [{'name': param_name, 'type': param_ctype.to_dict()}],
        },
    })


# The last solve, before `to_json_safe` strips it.  A lowered `Seq` is a live
# object and cannot cross to JS, so the one place that can still run the
# minimized program is here, in the worker that produced it.
_LAST = {}


CODEC_TARGET = 'codec'

# Above this the C view is replaced by a note; see where it is used.
C_RENDER_LIMIT = 20000


def _keep(result):
    """Remember the solve, and add the codec to the targets it can be seen as.

    The artifact comes from the *abstract* program, not from any target's
    lowered sequence. That is what makes it a single source of truth rather
    than a fourth listing: it is a property of the solve, and the same one
    whichever machine you are looking at.
    """
    _LAST.clear()
    if not result.get('ok') or not result.get('program_object'):
        return result

    _LAST['*input_bits'] = result['frontend']['input_bits']
    _LAST['*output_bits'] = result['frontend']['output_bits']
    _LAST['*primary'] = result.get('primary_target')

    from vm import codec as vm_codec, emit, image as vm_image, lower

    input_bits, output_bits = _LAST['*input_bits'], _LAST['*output_bits']
    try:
        picture = lower.lower_program(result['program_object'],
                                      input_bits, output_bits)
    except lower.Unsupported as exc:
        _LAST['*artifact_error'] = str(exc)
        return result

    payload = vm_image.serialize(picture)
    blob = vm_codec.pack(vm_codec.code(payload))
    _LAST['*artifact'] = blob
    _LAST['*image'] = picture

    name = (result['frontend'].get('function') or {}).get('name') or 'kernel'
    primary = next((t for t in result.get('targets') or []
                    if t['name'] == result.get('primary_target')), None)
    steps = sum(1 for at in picture.memory if at >= 0) // 3

    result.setdefault('targets', []).append({
        'name': CODEC_TARGET,
        'isa': {'name': CODEC_TARGET, 'title': 'codec',
                'note': 'the artifact itself'},
        'ok': True,
        # An rSUBLEQ program is a chain: every instruction depends on the one
        # before it, so span and work are the same number and saying otherwise
        # would invent parallelism the machine does not have.
        'span': steps,
        'work': steps,
        'core_ops': (result.get('program') or {}).get('core_ops'),
        'instructions': ['SUBLEQ'],
        'L_bits': vm_codec.length(payload),
        'L_bytes': len(blob),
        'cells': len(picture.memory),
        'asm': emit.emit_listing(picture, name, input_bits, output_bits),
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

    There is one, not one per target: `_keep` builds it from the abstract
    program the solve produced. The argument is accepted and ignored so a
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
