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
        'opt_levels': ['-O1', '-O2', '-O3'],
        'source_targets': ['x86-64', 'x86-64-v2', 'x86-64-v3', 'x86-64-v4'],
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


def finish(source, options_json='{}', table=None, assembly=''):
    """Run the pipeline on a table the worker has already evaluated."""
    options = json.loads(options_json or '{}')
    options = dict(options)
    options['table'] = list(table or [])
    options['assembly'] = assembly or ''
    result = solve(source, function=options.get('function'),
                   observer=options.get('observer', 'exact'),
                   targets=options.get('targets'),
                   frontend='precompiled', options=options)
    return _dumps(to_json_safe(result))


def fallback(source, options_json='{}'):
    """Run the whole pipeline in Python, with no compiler involved.

    Two things land here: C, when the Clang bundle cannot be fetched — slower
    and limited to the subset, but the page still answers — and any paste
    `route` identified as a listing, which never needed a compiler at all.
    """
    options = json.loads(options_json or '{}')
    result = solve(source, function=options.get('function'),
                   observer=options.get('observer', 'exact'),
                   targets=options.get('targets'),
                   frontend='cfront', options=options)
    return _dumps(to_json_safe(result))
