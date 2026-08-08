"""The whole product in one call.

    source text
      -> frontend            (SPEC §2)
      -> semantics           (SPEC §4)
      -> quotients           (SPEC §5)
      -> normalization       (SPEC §6)
      -> guards              (SPEC §7)
      -> synthesis           (SPEC §8, §9)
      -> lowering            (SPEC §10, §11)
      -> verification        (SPEC §12)
      -> report              (SPEC §13..§16, §18..§20)

The web worker and the CLI are both thin wrappers around `solve`.

Layer 5.
"""

import time

from . import corpus as corpus_mod
from . import frontend as frontend_mod
from . import isa as isa_mod
from . import observer as observer_mod
from . import quotient as quotient_mod
from . import recognize as recognize_mod
from . import solvers as solvers_mod
from .cfront import CFrontError
from .guards import derive_guard, guard_evidence
from .version import version_block

DEFAULT_TARGETS = list(isa_mod.DEFAULT_PROFILES)

# How many domain points are used to pick between physical representatives.
# The chosen lowering is afterwards verified over the whole domain.
SELECTION_SAMPLE = 512


def solve(source, function=None, observer='exact', targets=None,
          frontend='cfront', options=None):
    """Run the full pipeline.  Never raises for user-input problems."""
    started = time.time()
    options = dict(options or {})
    targets = list(targets or DEFAULT_TARGETS)

    try:
        return _solve(source, function, observer, targets, frontend, options,
                      started)
    except CFrontError as exc:
        return {
            'ok': False,
            'stage': 'frontend',
            'error': exc.to_dict(),
            'versions': version_block(),
        }
    except KeyError as exc:
        return {
            'ok': False,
            'stage': 'targets',
            'error': {'message': str(exc), 'text': str(exc)},
            'versions': version_block(),
        }
    except ValueError as exc:
        return {
            'ok': False,
            'stage': 'pipeline',
            'error': {'message': str(exc), 'text': str(exc)},
            'versions': version_block(),
        }


def _solve(source, function, observer_spec, targets, frontend_name, options,
           started):
    # -- §2 frontend -------------------------------------------------------
    front = frontend_mod.choose(frontend_name, source)
    analysis = front.analyze(source, dict(options, function=function))
    sem = analysis.semantics

    # -- §3 observer -------------------------------------------------------
    obs = observer_mod.parse(observer_spec, sem.output_bits)

    # -- §5 quotients ------------------------------------------------------
    observation = quotient_mod.observation_report(sem, obs)
    future = quotient_mod.streaming_future_quotient(
        sem, obs, max_input_bits=int(options.get('future_quotient_limit', 13)))

    # -- §8 synthesis ------------------------------------------------------
    programs = solvers_mod.solve_all(sem, obs, options)

    result = {
        'ok': True,
        'versions': version_block(),
        'frontend': analysis.report,
        'semantics': sem.to_dict(),
        'observer': obs.to_dict(),
        'quotients': {'observation': observation, 'future': future},
        'search': {
            'solvers': [s.__name__ for s in solvers_mod.COMPACT_SOLVERS],
            'programs_found': len(programs),
            'families': sorted(set(p.solver for p in programs)),
        },
        'recognition': recognize_mod.recognize(sem, obs),
    }

    if not programs:
        result['program'] = None
        result['residual_freedom'] = 0
        result['targets'] = []
        result['note'] = (
            'no program exists in the declared grammar for this observer; '
            'SPEC §9: a zero result refers to the current search family, not '
            'to the target function in general')
        result['derivation'] = _derivation(result, None, [])
        result['elapsed_s'] = round(time.time() - started, 3)
        return result

    # -- §10/§11 lowering, §12 verification --------------------------------
    # Rank candidates on a sample, then verify only the winner over the whole
    # domain on every target.  Full-domain verification of every rejected
    # candidate on every ISA is work whose result is thrown away.
    sample = _selection_sample(sem)
    per_program = []
    for program in programs:
        entry = {'program': program, 'targets': {}}
        for name in targets:
            entry['targets'][name] = _lower_one(program, name, sample, obs,
                                                sample)
        per_program.append(entry)

    primary_isa = targets[0]
    ranked = sorted(per_program, key=lambda e: _rank_key(e, targets))
    best = ranked[0]
    program = best['program']
    # Several profiles usually lower to the same instructions — x86-64 and
    # portable differ in what they *offer*, not in what wins — and verifying
    # the same sequence against the same semantics twice is the same
    # computation, on a domain where that costs 65,536 evaluations.  `rank` is
    # the encoded program, so equal ranks are the same program.
    verified = {}
    for name in targets:
        best['targets'][name] = _lower_one(program, name, sem, obs, sample,
                                           verified)

    result['program'] = program.to_dict()
    result['residual_freedom'] = program.residual_freedom
    result['normalization'] = {
        'classes': program.classes,
        'guards': _guards_for(program),
        'guard_evidence': guard_evidence(),
    }
    result['targets'] = [
        _target_record(name, best['targets'][name], sem, obs, program)
        for name in targets
    ]
    result['primary_target'] = _first_ok(result['targets']) or primary_isa
    result['alternatives'] = [
        {
            'solver': entry['program'].solver,
            'classes': entry['program'].classes,
            'core_ops': entry['program'].core_ops,
            'residual_freedom': entry['program'].residual_freedom,
            'best_span': _best_span(entry, targets),
        }
        for entry in ranked[1:]
    ]

    # -- §19/§20 corpus ----------------------------------------------------
    key = corpus_mod.semantic_key(sem, obs)
    primary_record = _record_by_name(result['targets'], result['primary_target'])
    result['corpus'] = {
        'semantic_key': key,
        'canonical': key is not None,
        'note': ('a sampled domain has no canonical semantic identity'
                 if key is None else
                 'key covers observed semantics only; no source text'),
    }
    result['contribution'] = (
        corpus_mod.contribution_record(key, result['primary_target'],
                                       primary_record or {},
                                       result['program'],
                                       result['recognition'])
        if key else None)

    # -- §17 cost model ----------------------------------------------------
    result['cost_model'] = _cost_model(analysis.report, result['targets'])

    # -- §14 derivation ----------------------------------------------------
    result['derivation'] = _derivation(result, program, ranked)
    result['elapsed_s'] = round(time.time() - started, 3)
    return result


# ---------------------------------------------------------------------------
# Lowering, verification and ranking
# ---------------------------------------------------------------------------

def _selection_sample(sem):
    values = sem.domain.values()
    if len(values) <= SELECTION_SAMPLE:
        return sem
    step = max(1, len(values) // SELECTION_SAMPLE)
    picked = values[::step][:SELECTION_SAMPLE]
    picked = list(dict.fromkeys(list(picked) + [1 << i for i in range(sem.input_bits)]))
    return sem.restricted([v for v in picked if v < (1 << sem.input_bits)])


def _lower_one(program, isa_name, sem, obs, sample, verified=None):
    isa = isa_mod.get_isa(isa_name)
    try:
        seq, used = isa_mod.lower_program(program, isa, verify_against=(sample, obs))
    except isa_mod.LoweringFailure as exc:
        return {'ok': False, 'reason': str(exc)}

    span, work, l_bits, rank = isa_mod.measure(seq)
    if verified is None:
        matched, total = isa_mod.matches(seq, sem, obs)
    elif rank in verified:
        matched, total = verified[rank]
    else:
        matched, total = verified[rank] = isa_mod.matches(seq, sem, obs)

    return {
        'ok': matched == total,
        'seq': seq,
        'representatives': [(op.label, name) for op, name in used],
        'span': span,
        'work': work,
        'L_bits': l_bits,
        'rank': rank,
        'matched': matched,
        'total': total,
    }


FALLBACK_SOLVERS = {'table'}


def _rank_key(entry, targets):
    """Lexicographic objective, evaluated on the first target that lowers.

    The finite-domain lookup table is ranked as a fallback rather than as a
    minimum.  Under a plain (span, work) comparison a 2 KB table would "win"
    every 8-bit kernel with one instruction, which would make the product
    answer a different question than the one SPEC §35 asks: how little machine
    *computation* the observable meaning requires.  The table is still
    reported, and it is still what makes "no solution" mean "no compact
    solution".
    """
    fallback = 1 if entry['program'].solver in FALLBACK_SOLVERS else 0
    for name in targets:
        rec = entry['targets'].get(name)
        if rec and rec.get('ok'):
            return (fallback, 0, rec['span'], rec['work'], rec['L_bits'],
                    rec['rank'])
    return (fallback, 1, 1 << 30, 1 << 30, 1 << 30, 0)


def _best_span(entry, targets):
    for name in targets:
        rec = entry['targets'].get(name)
        if rec and rec.get('ok'):
            return rec['span']
    return None


def _target_record(name, lowered, sem, obs, program):
    isa = isa_mod.get_isa(name)
    record = {'isa': isa.to_dict(), 'name': name}
    if not lowered.get('ok'):
        record['ok'] = False
        record['reason'] = lowered.get(
            'reason', 'lowered program failed verification on this target')
        if 'matched' in lowered:
            record['verification'] = _verification(sem, lowered['matched'],
                                                   lowered['total'], obs)
        return record

    seq = lowered['seq']
    fn_name = (sem.meta.get('function') or 'qm_kernel') + '_qm'
    record.update({
        'ok': True,
        # Kept for in-process callers; `to_json_safe` strips it before the
        # result crosses the worker boundary.
        'seq': seq,
        'span': lowered['span'],
        'work': lowered['work'],
        'L_bits': lowered['L_bits'],
        'L_bytes': -(-lowered['L_bits'] // 8),
        'core_ops': program.core_ops,
        'instructions': isa_mod.instruction_names(seq),
        'representatives': lowered['representatives'],
        'verification': _verification(sem, lowered['matched'], lowered['total'],
                                      obs),
        'observer': obs.to_dict(),
        'c': isa_mod.emit_c(seq, fn_name,
                            input_ctype=_ctype_for(sem.input_bits),
                            output_ctype=_ctype_for(sem.output_bits)),
    })
    # Each target gets the listing its own machine reads.  The width is written
    # into both, because a listing does not otherwise say how wide its input
    # was meant to be, and a round trip has to land on the same domain.
    if name == 'wasm32':
        record['asm'] = isa_mod.emit_wasm(seq, fn_name, sem.input_bits)
        record['asm_dialect'] = 'wasm32'
    else:
        record['asm'] = isa_mod.emit_asm(seq, fn_name, sem.input_bits)
        record['asm_dialect'] = 'x86-64'
    return record


def _ctype_for(bits):
    for width in (8, 16, 32, 64):
        if bits <= width:
            return 'uint%d_t' % width
    return 'uint64_t'


def _verification(sem, matched, total, obs):
    return {
        'mode': ('exact exhaustive' if sem.domain.exhaustive
                 else 'basis + boundary + deterministic differential'),
        'exhaustive': sem.domain.exhaustive,
        'matched': matched,
        'total': total,
        'pass': matched == total,
        'observer': obs.spec,
        'domain_note': sem.domain.note,
        'claim': ('equivalence proved on every input of the declared domain'
                  if sem.domain.exhaustive else
                  'agreement on the probed inputs only; this is not a proof of '
                  'global equivalence'),
    }


def _first_ok(records):
    for record in records:
        if record.get('ok'):
            return record['name']
    return None


def _record_by_name(records, name):
    for record in records:
        if record['name'] == name:
            return record
    return None


def _guards_for(program):
    out = []
    for op in program.ops:
        if op.kind != 'CONV':
            continue
        family = op.detail['family']
        trivial = family == 'CLMUL'      # truncation mod x^64 is trivial
        entry = derive_guard(family, op.detail.get('lane_width'), trivial)
        entry['for'] = op.label
        out.append(entry)
    return out


def _cost_model(front_report, targets):
    """SPEC §17, honestly scoped.

    Cycle-level numbers need native execution (SPEC §27); in the browser QM
    compares the static model only, and says so.
    """
    reference = front_report.get('reference_ops', {})
    rows = []
    for record in targets:
        if not record.get('ok'):
            continue
        rows.append({
            'target': record['name'],
            'span': record['span'],
            'work': record['work'],
            'instructions': len(record['instructions']),
            'code_bits': record['L_bits'],
        })
    return {
        'frontend_reference_ops': reference.get('mean'),
        'rows': rows,
        'note': 'static cost model only. Measured cycles/throughput/latency '
                'require native execution and are not available in the browser '
                'sandbox; the UI must not present these as timings.',
    }


# ---------------------------------------------------------------------------
# SPEC §14 derivation
# ---------------------------------------------------------------------------

def _derivation(result, program, ranked):
    steps = []
    front = result['frontend']
    steps.append(('Input', '%s, %s' % (front['function']['signature'],
                                       front['frontend']['title'])))
    steps.append(('Semantics', '%d-bit input -> %d-bit output, %s'
                  % (result['semantics']['input_bits'],
                     result['semantics']['output_bits'],
                     result['semantics']['domain']['strength'])))
    steps.append(('Observer', result['observer']['description']))

    obs_report = result['quotients']['observation']
    steps.append(('Observation quotient',
                  'identity on this domain' if obs_report['is_identity_on_domain']
                  else '%d distinct outputs collapse to %d observables'
                       % (obs_report['distinct_outputs'],
                          obs_report['distinct_observables'])))

    future = result['quotients']['future']
    if future.get('computed'):
        steps.append(('Future quotient',
                      'streaming state needs %d bits at its peak (%d classes), '
                      'against %d bits of raw input history'
                      % (future['state_bits'], future['peak_classes'],
                         future['naive_state_bits'])))
    else:
        steps.append(('Future quotient', 'not computed: %s'
                      % future.get('reason', 'unavailable')))

    if program is None:
        steps.append(('Normalization', 'no program in the declared grammar'))
        return [{'step': a, 'value': b} for a, b in steps]

    steps.append(('Normalization', ' ; '.join(op.label for op in program.ops)))
    guards = result.get('normalization', {}).get('guards') or []
    if guards:
        steps.append(('Guards', '; '.join(
            '%s -> %s (%d op)' % (g['for'], g['name'] or 'none', g['cost'])
            for g in guards)))
    steps.append(('Candidates', str(program.candidates)))
    steps.append(('Residual freedom', '%d solution(s) in family %s'
                  % (program.residual_freedom, program.solver)))
    steps.append(('Canonical representative',
                  'minimum (span, work, L(z), rank)'))

    primary = _record_by_name(result['targets'], result['primary_target'])
    if primary and primary.get('ok'):
        steps.append(('Lowering', '%s: %s'
                      % (primary['name'], ' '.join(primary['instructions']))))
        steps.append(('Verification', '%s %d / %d'
                      % (primary['verification']['mode'],
                         primary['verification']['matched'],
                         primary['verification']['total'])))
    if ranked and len(ranked) > 1:
        steps.append(('Other families that also verify',
                      ', '.join(sorted(set(e['program'].solver
                                           for e in ranked[1:])))))
    return [{'step': a, 'value': b} for a, b in steps]


# ---------------------------------------------------------------------------
# JSON-safe view for the browser and the CLI
# ---------------------------------------------------------------------------

def to_json_safe(result):
    """Strip live objects (Seq) so the result can cross a worker boundary."""
    def clean(value):
        if isinstance(value, dict):
            return dict((k, clean(v)) for k, v in value.items() if k != 'seq')
        if isinstance(value, (list, tuple)):
            return [clean(v) for v in value]
        if isinstance(value, int) and abs(value) >= (1 << 53):
            return '0x%X' % value
        return value
    return clean(result)
