"""SPEC §2 — the frontend stage.

A frontend turns pasted source into `Semantics` plus a "what did the input cost
before QM" number.  Frontends are registered here so that the Clang/WASM
frontend described in SPEC §2 can be added without touching the pipeline:

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

# The solvers in this prototype are unary; keep the reason explicit.
UNARY_ONLY_HINT = ('the Stage-2 solver family in this prototype takes one '
                   'integer input; combine arguments into a single word to '
                   'analyse a multi-argument kernel')


class FrontendResult(object):
    """What a frontend hands to the pipeline."""

    __slots__ = ('semantics', 'report', 'function', 'unit')

    def __init__(self, semantics, report, function=None, unit=None):
        self.semantics = semantics
        self.report = report
        self.function = function
        self.unit = unit


def pick_function(unit, requested=None):
    """Choose the kernel to analyse.

    Explicit request wins.  Otherwise pick a function that nothing else in the
    paste calls — the root of the little call graph — falling back to the last
    definition.
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
    return roots[-1] if roots else unit.functions[-1]


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

        if len(fn.params) != 1:
            raise CFrontError(
                '%s takes %d arguments; exactly one is required'
                % (fn.name, len(fn.params)), line=fn.line, hint=UNARY_ONLY_HINT)

        param = fn.params[0]
        if param.ctype.kind not in ('int', 'bool'):
            raise CFrontError('parameter %r must be an integer type'
                              % param.name, line=fn.line)
        if param.ctype.bits > 64:
            raise CFrontError(
                'parameter %r is %d bits; the solver family takes at most 64'
                % (param.name, param.ctype.bits), line=fn.line,
                hint='a 128-bit input would be silently truncated, so it is '
                     'refused instead')
        if fn.ret.kind == 'void':
            raise CFrontError('%s returns void, so nothing is observable'
                              % fn.name, line=fn.line)
        if fn.ret.bits > 64:
            raise CFrontError('return width %d exceeds the 64-bit lowering '
                              'grammar' % fn.ret.bits, line=fn.line)

        input_bits = min(param.ctype.bits, int(options.get('max_input_bits', 64)))
        if options.get('input_bits'):
            input_bits = int(options['input_bits'])
        output_bits = fn.ret.bits

        # Bulk evaluation uses the compiler; the instrumented interpreter is
        # only run on a sample, because counting operations is the one thing
        # the fast path deliberately does not do.
        compiled = compile_unit(unit).function(fn.name)
        out_mask = mask_of(output_bits)

        def target(x):
            return compiled(x) & out_mask

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
            # Definitions outside the subset are skipped, never silently: they
            # are named here so a surprising result can be traced to one.
            'skipped_definitions': [
                {'name': item['name'], 'line': item['line'],
                 'reason': item['reason']}
                for item in unit.skipped
            ],
            'input_bits': input_bits,
            'output_bits': output_bits,
            'reference_ops': self._reference_ops(unit, fn, domain, options),
        }
        return FrontendResult(sem, report, fn, unit)

    @staticmethod
    def _reference_ops(unit, fn, domain, options):
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
                interp.call(fn.name, [x])
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
    """SPEC §2 — real Clang -O2 as the entry point.

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
        _require_unary(signature)

        param_name, param_ctype = signature['params'][0]
        input_bits = min(param_ctype.bits,
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
            'functions_in_source': [signature['name']],
            'input_bits': input_bits,
            'output_bits': output_bits,
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
            'functions_in_source': [name],
            'input_bits': input_bits,
            'output_bits': output_bits,
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


def _require_unary(signature):
    if len(signature['params']) != 1:
        raise CFrontError('%s takes %d arguments; exactly one is required'
                          % (signature['name'], len(signature['params'])),
                          hint=UNARY_ONLY_HINT)
    if signature['ret'].kind == 'void':
        raise CFrontError('%s returns void, so nothing is observable'
                          % signature['name'])
    if signature['ret'].bits > 64:
        raise CFrontError('return width %d exceeds the 64-bit lowering grammar'
                          % signature['ret'].bits)


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


def get(name=None):
    if not name or name == 'auto':
        # SPEC §2 wants Clang at the entry; the built-in subset is the
        # fallback for when no toolchain is reachable, not the default.
        clang = REGISTRY['clang']
        return clang if clang.available() else REGISTRY['cfront']
    if name not in REGISTRY:
        raise CFrontError('unknown frontend %r' % name,
                          hint='available: %s' % ', '.join(sorted(REGISTRY)))
    return REGISTRY[name]


def list_frontends():
    return [f.describe() for f in REGISTRY.values()]
