"""The frontend stage.

A frontend turns pasted source into `Semantics` plus a "what did the input cost
before QM" number.  Frontends are registered here so that the Clang/WASM
frontend can be added without touching the pipeline:

    Frontend protocol
        name        str, stable id used by the UI and the result record
        title       str, human label
        available() bool
        analyze(source, options) -> FrontendResult

Layer 3: depends on `bits`, `semantics`, `cfront`.
"""

from .bits import mask_of
from .cfront import CFrontError, Interpreter, compile_unit, parse
from .semantics import Semantics, choose_domain

SCALAR_INPUT_HINT = ('integer parameters are packed low-to-high in declaration '
                     'order into one at-most-64-bit solver coordinate')


class FrontendResult(object):
    """What a frontend hands to the pipeline."""

    __slots__ = ('semantics', 'report', 'function', 'unit')

    def __init__(self, semantics, report, function=None, unit=None):
        self.semantics = semantics
        self.report = report
        self.function = function
        self.unit = unit


def analysable(ret, params, max_input_bits=64):
    """Why this signature cannot be the kernel, or None if it can.

    Integer inputs totaling at most 64 bits and one scalar output.
    Everything here is a property of *this prototype's solver family*, not of
    the function — hence the reasons, which the report passes on.
    """
    if not params:
        return 'takes no arguments, so there is no input coordinate'
    total = 0
    for param in params:
        ctype = param[1] if isinstance(param, tuple) else param.ctype
        if ctype.kind not in ('int', 'bool'):
            return 'an argument is not an integer type'
        total += ctype.bits
    if total > max_input_bits:
        return ('the arguments total %d bits; at most %d are supported'
                % (total, max_input_bits))
    if ret.kind == 'void':
        return 'returns void, so nothing is observable'
    if ret.bits > 64:
        return 'returns %d bits; the lowering grammar is 64' % ret.bits
    return None


def parameter_layout(params):
    """Stable low-to-high coordinates for a sequence of integer parameters."""
    layout = []
    offset = 0
    for param in params:
        if isinstance(param, tuple):
            name, ctype = param
        else:
            name, ctype = param.name, param.ctype
        layout.append({'name': name, 'type': ctype.name,
                       'bits': ctype.bits, 'offset': offset})
        offset += ctype.bits
    return layout


def unpack_parameters(value, layout):
    value = int(value)
    return tuple((value >> item['offset']) & mask_of(item['bits'])
                 for item in layout)


def _signature_of(fn):
    return fn.ret, [(p.name, p.ctype) for p in fn.params]


def pick_function(unit, requested=None):
    """Choose the kernel to analyse.

    Explicit request wins, whatever it is — an explicit choice that cannot be
    analysed should say so about *that* function, not quietly analyse another.

    Otherwise: a function nothing else in the paste calls, the root of the
    little call graph, preferring one this prototype can actually take. A
    multi-parameter root remains one reversible scalar coordinate downstream.
    """
    if requested:
        fn = unit.by_name(requested)
        if fn is None:
            raise CFrontError('function %r is not defined in this source'
                              % requested,
                              hint='defined here: %s' % ', '.join(unit.names()))
        return fn

    called = set()
    for fn in unit.functions:
        _collect_calls(fn.body, called)
    roots = [fn for fn in unit.functions if fn.name not in called]

    for order in (roots, unit.functions):
        usable = [fn for fn in order if analysable(*_signature_of(fn)) is None]
        if usable:
            return usable[-1]
    return roots[-1] if roots else unit.functions[-1]


def rejections(unit, chosen):
    """[{name, reason}] for every function in the paste that was not taken."""
    out = []
    for fn in unit.functions:
        if fn is chosen:
            continue
        out.append({'name': fn.name,
                    'reason': analysable(*_signature_of(fn)) or 'not the root'})
    return out


def _other_candidates_hint(unit, chosen):
    """Name any function in the paste that *could* have been analysed."""
    usable = [fn.name for fn in unit.functions
              if fn is not chosen and analysable(*_signature_of(fn)) is None]
    if usable:
        return ('this paste also defines %s, which the solver family can take'
                % ', '.join(usable))
    return SCALAR_INPUT_HINT


def _collect_calls(node, out):
    """Walk any AST node collecting called function names."""
    if node is None:
        return
    if isinstance(node, list):
        for item in node:
            _collect_calls(item, out)
        return
    name = getattr(node, 'name', None)
    if name is not None and type(node).__name__ == 'Call':
        out.add(name)
    for field in getattr(node, 'fields', ()):
        value = getattr(node, field, None)
        if hasattr(value, 'fields') or isinstance(value, list):
            _collect_calls(value, out)


class CSubsetFrontend(object):
    """Built-in frontend: interprets the pasted C directly.

    It provides exact semantics with no download and no toolchain, which is what
    makes "open a URL, paste C" work offline after first load.
    """

    name = 'cfront'
    title = 'Built-in C subset interpreter'
    kind = 'interpreter'

    def available(self):
        return True

    def describe(self):
        return {
            'name': self.name,
            'title': self.title,
            'kind': self.kind,
            'available': True,
            'baseline_metric': 'unrolled reference operation count',
            'note': 'operation counts are this frontend\'s own reference cost '
                    'model, not the output of any particular compiler',
        }

    def analyze(self, source, options=None):
        options = options or {}
        unit = parse(source)
        fn = pick_function(unit, options.get('function'))

        why = analysable(*_signature_of(fn))
        if why:
            raise CFrontError('%s %s' % (fn.name, why), line=fn.line,
                              hint=_other_candidates_hint(unit, fn))
        layout = parameter_layout(fn.params)
        input_bits = min(sum(item['bits'] for item in layout),
                         int(options.get('max_input_bits', 64)))
        if options.get('input_bits'):
            input_bits = int(options['input_bits'])
        output_bits = fn.ret.bits

        # Bulk evaluation uses the compiler; the instrumented interpreter is
        # only run on a sample, because counting operations is the one thing
        # the fast path deliberately does not do.
        compiled = compile_unit(unit).function(fn.name)
        out_mask = mask_of(output_bits)

        def target(x):
            return compiled(*unpack_parameters(x, layout)) & out_mask

        domain = choose_domain(
            input_bits,
            exhaustive_limit=int(options.get('exhaustive_limit', 16)),
            probes=int(options.get('probes', 4096)),
        )
        sem = Semantics(target, input_bits, output_bits, domain,
                        meta={'function': fn.name, 'source': 'cfront'})

        report = {
            'frontend': self.describe(),
            'function': fn.to_dict(),
            'functions_in_source': unit.names(),
            # Which of them could not be the kernel, and why.  A paste of
            # twenty is normal; saying which one was taken, and what was wrong
            # with the rest, is the difference between a choice and a guess.
            'other_functions': rejections(unit, fn),
            # Definitions outside the subset are skipped, never silently: they
            # are named here so a surprising result can be traced to one.
            'skipped_definitions': [
                {'name': item['name'], 'line': item['line'],
                 'reason': item['reason']}
                for item in unit.skipped
            ],
            'input_bits': input_bits,
            'output_bits': output_bits,
            'parameter_layout': layout,
            'reference_ops': self._reference_ops(unit, fn, domain, options,
                                                  layout),
        }
        return FrontendResult(sem, report, fn, unit)

    @staticmethod
    def _reference_ops(unit, fn, domain, options, layout):
        """Reference operation count, measured on a sample of the domain."""
        sample_size = int(options.get('cost_sample', 128))
        values = domain.values()
        if len(values) > sample_size:
            step = max(1, len(values) // sample_size)
            values = values[::step][:sample_size]

        interp = Interpreter(unit)
        counts = []
        for x in values:
            interp.reset_counters()
            try:
                interp.call(fn.name, unpack_parameters(x, layout))
            except CFrontError:
                continue
            counts.append(interp.ops)

        if not counts:
            return {'metric': 'unavailable', 'mean': None}
        return {
            'mean': round(sum(counts) / float(len(counts)), 2),
            'max_sampled': max(counts),
            'min_sampled': min(counts),
            'sampled_inputs': len(counts),
            'metric': 'primitive operations executed per call, loops unrolled '
                      'by execution, measured on %d sampled inputs'
                      % len(counts),
        }


class ClangFrontend(object):
    """Use real Clang -O2 as a source-normalizing entry point.

    Semantics come from executing the optimized code, not from re-modelling it,
    so anything Clang accepts is analysable and the extracted function is by
    construction the function the compiler produced.
    """

    name = 'clang'
    title = 'Clang -O2 (native toolchain)'
    kind = 'compiler'

    def __init__(self, toolchain=None):
        from . import clang as clang_mod
        self.toolchain = toolchain or clang_mod.NATIVE
        self._mod = clang_mod

    def available(self):
        return self.toolchain.available()

    def describe(self):
        available = self.available()
        out = {
            'name': self.name,
            'title': self.title,
            'kind': self.kind,
            'available': available,
            'baseline_metric': 'x86-64 instructions emitted by Clang',
        }
        if available:
            out['version'] = self.toolchain.version()
        else:
            out['reason'] = 'no Clang toolchain is reachable from this process'
        return out

    def analyze(self, source, options=None):
        from .asmstats import analyze as analyze_asm
        options = options or {}
        opt = options.get('opt', '-O2')
        target = options.get('source_target', 'x86-64')

        signature = self._mod.read_signature(source, options.get('function'))
        require_analysable(signature)

        layout = parameter_layout(signature['params'])
        input_bits = min(sum(item['bits'] for item in layout),
                         int(options.get('max_input_bits', 64)))
        if options.get('input_bits'):
            input_bits = int(options['input_bits'])
        output_bits = signature['ret'].bits

        domain = choose_domain(
            input_bits,
            exhaustive_limit=int(options.get('exhaustive_limit', 16)),
            probes=int(options.get('probes', 4096)),
        )
        outputs = self.toolchain.evaluate(source, signature, domain.values(),
                                          opt=opt, target=target)
        sem = table_semantics(outputs, input_bits, output_bits, domain,
                              meta={'function': signature['name'],
                                    'source': 'clang'})

        asm = self.toolchain.assembly(source, opt=opt, target=target)
        stats = analyze_asm(asm, signature['name'])

        report = {
            'frontend': self.describe(),
            'function': _signature_dict(signature),
            'functions_in_source': [signature['name']]
                                   + [f['name'] for f in signature.get('others') or []],
            'other_functions': signature.get('others') or [],
            'input_bits': input_bits,
            'output_bits': output_bits,
            'parameter_layout': layout,
            'compile': {'opt': opt, 'target': target,
                        'signature_via': signature.get('via')},
            'assembly': asm,
            'assembly_stats': stats,
            'reference_ops': {
                'mean': stats.get('instructions'),
                'metric': '%s instructions emitted by Clang %s for %s'
                          % (stats.get('isa', 'machine'), opt, target),
            },
        }
        return FrontendResult(sem, report, None, None)


class PrecompiledFrontend(object):
    """The browser's Clang/WASM path.

    `web/worker.js` compiles the paste with clang.wasm, instantiates the wasm32
    module and calls the exported function over the domain.  Evaluating 65,536
    inputs then costs milliseconds instead of a minute, because the kernel runs
    as compiled code rather than as an interpreted tree.

    Everything after this point is identical to the native path: the pipeline
    only ever sees a table.
    """

    name = 'precompiled'
    title = 'Clang/WASM (in-browser)'
    kind = 'compiler'

    def available(self):
        return True

    def describe(self):
        return {'name': self.name, 'title': self.title, 'kind': self.kind,
                'available': True,
                'baseline_metric': 'x86-64 instructions emitted by Clang'}

    def analyze(self, source, options=None):
        from .asmstats import analyze as analyze_asm
        options = options or {}
        outputs = options.get('table')
        if not outputs:
            raise CFrontError('the precompiled frontend needs an evaluated '
                              'table from the compiler driver')

        input_bits = int(options['input_bits'])
        output_bits = int(options['output_bits'])
        domain = choose_domain(
            input_bits,
            exhaustive_limit=int(options.get('exhaustive_limit', 16)),
            probes=int(options.get('probes', 4096)),
        )
        if len(outputs) != len(domain):
            raise CFrontError('table has %d entries but the domain has %d'
                              % (len(outputs), len(domain)))

        name = options.get('function') or 'kernel'
        sem = table_semantics(outputs, input_bits, output_bits, domain,
                              meta={'function': name, 'source': 'clang-wasm'})

        compile_info = options.get('compile') or {}
        asm = options.get('assembly') or ''
        stats = (analyze_asm(asm, name, compile_info.get('listing_isa'))
                 if asm else {'available': False,
                              'reason': 'the toolchain produced no listing'})
        describe = self.describe()
        toolchain = options.get('toolchain') or {}
        if toolchain.get('title'):
            describe['title'] = toolchain['title']
        describe['bundle'] = toolchain.get('bundle')
        describe['listing'] = stats.get('isa') or compile_info.get('listing_isa')

        report = {
            'frontend': describe,
            'function': options.get('signature') or {'name': name,
                                                     'signature': name},
            # The paste was parsed on the way in, by `plan`; the worker carries
            # what it learned across so this path can say which of several
            # functions it answered about, exactly as the others do.
            'functions_in_source': [name] + [f['name'] for f in
                                             options.get('other_functions') or []],
            'other_functions': options.get('other_functions') or [],
            'input_bits': input_bits,
            'output_bits': output_bits,
            'parameter_layout': (options.get('parameter_layout')
                                 or options.get('parameters')),
            'compile': compile_info,
            'assembly': asm,
            'assembly_stats': stats,
            'reference_ops': {
                'mean': stats.get('instructions'),
                'metric': '%s instructions emitted by Clang %s'
                          % (stats.get('isa', 'machine'),
                             compile_info.get('opt', '-O2')),
            },
        }
        return FrontendResult(sem, report, None, None)


class AssemblyFrontend(object):
    """Accept optimized assembly directly as a QM input.

    x86-64 in AT&T syntax or wasm32 in the text format.  Semantics come from
    evaluating the listing, exactly as the Clang path evaluates the compiled
    module, so the pipeline downstream cannot tell the two apart — which is what
    makes x86 -> wasm and wasm -> x86 ordinary uses of it rather than features.

    The one thing a listing cannot tell you is how wide its input was meant to
    be: `%rdi` is 64 bits whether the kernel took a byte or a word.  QM writes
    the width into what it emits and reads it back here; without it the width
    has to be assumed, and the report says which happened.
    """

    name = 'asm'
    title = 'x86-64 / wasm32 assembly'
    kind = 'assembly'

    def available(self):
        return True

    def describe(self):
        return {
            'name': self.name,
            'title': self.title,
            'kind': self.kind,
            'available': True,
            'baseline_metric': 'instructions in the pasted listing',
            'note': 'the lightweight integer reader is the fast path; on a '
                    'sandbox-capable Linux x86-64 host, other deterministic '
                    'instructions fall back to the native execution oracle',
        }

    def analyze(self, source, options=None):
        from . import asmfront
        options = options or {}
        dialect = options.get('dialect') or asmfront.detect(source)
        fast_error = None
        try:
            function, dialect = asmfront.parse(source,
                                               options.get('function'), dialect)
            evaluate = asmfront.compile_function(function)
        except CFrontError as exc:
            fast_error = exc
            if dialect != 'x86-64':
                raise
            from .x86oracle import NativeX86Oracle, available, function_name
            if not available():
                raise
            name = function_name(source, options.get('function'))
            function = type('OracleFunction', (), {
                'name': name, 'input_bits': 64, 'output_bits': 64,
                'instructions': (),
            })()
            evaluate = None
        reader = asmfront.wasm if dialect == 'wasm32' else asmfront.x86

        declared = reader.declared_input_bits(source)
        natural = getattr(function, 'input_bits', 64)
        if options.get('input_bits'):
            input_bits, width_via = int(options['input_bits']), 'caller'
        elif declared:
            input_bits, width_via = declared, 'qm-input-bits annotation'
        else:
            input_bits, width_via = natural, 'operand width (%s)' % dialect
        input_bits = min(input_bits, int(options.get('max_input_bits', 64)))
        output_bits = getattr(function, 'output_bits', 64)

        domain = choose_domain(
            input_bits,
            exhaustive_limit=int(options.get('exhaustive_limit', 16)),
            probes=int(options.get('probes', 4096)),
        )
        if evaluate is None:
            from .x86oracle import NativeX86Oracle
            outputs = NativeX86Oracle(
                source, function.name,
                timeout=float(options.get('oracle_timeout', 30.0)),
            ).evaluate(domain.values())
            backend = 'sandboxed-native-oracle'
        else:
            outputs = [evaluate(x) for x in domain.values()]
            backend = 'lightweight-reader'
        sem = table_semantics(outputs, input_bits, output_bits, domain,
                              meta={'function': _base_name(function.name),
                                    'source': 'asm:%s' % dialect})

        if function.instructions:
            count = len(function.instructions)
        else:
            from .asmstats import analyze as analyze_asm
            count = analyze_asm(source, function.name,
                                isa=dialect).get('instructions', 0)
        report = {
            'frontend': dict(self.describe(),
                             listing=dialect, title='%s (%s)'
                             % (self.title, dialect)),
            'function': {
                'name': function.name,
                'signature': '%s %s(%s)' % (_ctype(output_bits), function.name,
                                            _ctype(input_bits)),
            },
            'functions_in_source': [function.name],
            'skipped_definitions': [],
            'input_bits': input_bits,
            'output_bits': output_bits,
            'compile': {'dialect': dialect, 'input_width_via': width_via,
                        'declared_input_bits': declared, 'backend': backend,
                        'fast_path_error': (str(fast_error)
                                            if fast_error else None)},
            'assembly': source,
            'assembly_stats': {'available': True, 'isa': dialect,
                               'instructions': count},
            'reference_ops': {
                'mean': count,
                'metric': '%d instruction(s) in the pasted %s listing'
                          % (count, dialect),
            },
        }
        return FrontendResult(sem, report, None, None)


def _ctype(bits):
    for width in (8, 16, 32, 64):
        if bits <= width:
            return 'uint%d_t' % width
    return 'uint64_t'


def _base_name(name):
    """`ranks8_qm` came from `ranks8`; do not stack the suffix every pass."""
    trimmed = name.lstrip('$')
    return trimmed[:-3] if trimmed.endswith('_qm') else trimmed


def require_analysable(signature):
    """Raise unless `read_signature`'s choice is one the solvers can take.

    The same `analysable` the parser path uses, so the two frontends cannot
    disagree about what this prototype accepts — and the hint names a sibling
    in the paste when there is one, because "takes two arguments" is not much
    use to someone who pasted a header of twenty kernels.
    """
    why = analysable(signature['ret'], signature['params'])
    if not why:
        return
    usable = [item['name'] for item in signature.get('others') or []
              if item.get('reason') == 'not the root']
    raise CFrontError(
        '%s %s' % (signature['name'], why),
        hint=('this paste also defines %s, which the solver family can take'
              % ', '.join(usable)) if usable else SCALAR_INPUT_HINT)


def _signature_dict(signature):
    args = ', '.join('%s %s' % (ctype.name, name)
                     for name, ctype in signature['params'])
    return {
        'name': signature['name'],
        'return': signature['ret'].to_dict(),
        'params': [{'name': n, 'type': t.to_dict()}
                   for n, t in signature['params']],
        'signature': '%s %s(%s)' % (signature['ret'].name, signature['name'],
                                    args or 'void'),
    }


def _as_int(value):
    """Accept the decimal strings the browser sends.

    A JSON number cannot carry 64 bits without loss, so the worker serializes
    each output as a string.  Parsing here keeps that detail out of every
    caller.
    """
    if isinstance(value, str):
        return int(value, 0)
    return int(value)


def table_semantics(outputs, input_bits, output_bits, domain, meta=None):
    """Wrap an evaluated table as `Semantics`."""
    out_mask = mask_of(output_bits)
    lookup = dict(zip(domain.values(),
                      [_as_int(v) & out_mask for v in outputs]))

    def target(x):
        try:
            return lookup[x]
        except KeyError:
            raise CFrontError('the compiled oracle was not evaluated at '
                              'input 0x%X' % x)

    sem = Semantics(target, input_bits, output_bits, domain, meta)
    sem._table = [lookup[x] for x in domain.values()]
    return sem


REGISTRY = {}


def register(frontend):
    REGISTRY[frontend.name] = frontend
    return frontend


register(CSubsetFrontend())
register(ClangFrontend())
register(PrecompiledFrontend())
register(AssemblyFrontend())


def get(name=None):
    if not name or name == 'auto':
        # Prefer the production compiler when reachable. The built-in C
        # subset is an offline fallback, not an independent semantics path.
        clang = REGISTRY['clang']
        return clang if clang.available() else REGISTRY['cfront']
    if name not in REGISTRY:
        raise CFrontError('unknown frontend %r' % name,
                          hint='available: %s' % ', '.join(sorted(REGISTRY)))
    return REGISTRY[name]


def choose(name, source):
    """Pick a frontend for this particular paste.

    A C frontend handed an assembly listing fails with a lexer error several
    lines in, which tells the user nothing useful.  Assembly is recognisable on
    sight, so recognise it — including when a C frontend was named, since a
    listing is never valid C and the alternative is a worse message.
    """
    from . import asmfront
    dialect = asmfront.detect(source)
    if dialect is None:
        return get(name)
    if not name or name in ('auto', 'asm', 'cfront', 'clang', 'precompiled'):
        return REGISTRY['asm']
    return get(name)


def list_frontends():
    return [f.describe() for f in REGISTRY.values()]
