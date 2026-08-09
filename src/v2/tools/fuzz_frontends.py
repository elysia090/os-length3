#!/usr/bin/env python3
"""Differential fuzzing for the x86-64 and wasm32 input paths.

The generator starts from one small SSA program, emits both listings, reads
both back, and compares every input in the declared finite domain.  A bounded
number of cases also goes through the complete minimizer and codec compiler.

The seed and case number are printed on failure, so every random case is a
permanent, pasteable reproduction rather than an unrepeatable sample.

Examples:

    python tools/fuzz_frontends.py --cases 1000 --seed 7
    python tools/fuzz_frontends.py --cases 100 --solve-cases 20
    python tools/fuzz_frontends.py --cases 20 --native-x86
"""

from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path
import random
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from qm import isa
from qm.asmfront import parse
from qm.bits import M64, mask_of
from qm.pipeline import solve
from vm import run


CONSTANTS = (
    0, 1, 2, 3, 7, 8, 0xFF, 0x100, 0x101, 0x5555555555555555,
    0x8080808080808080, 0xFFFFFFFF, M64,
)
IMMEDIATE = ('AND', 'OR', 'XOR', 'ADD', 'SUB', 'IMUL')
SHIFT = ('SHL', 'SHR', 'SAR')
UNARY = ('NOT', 'NEG', 'CLZ', 'CTZ')
BINARY = ('XORR', 'ANDR', 'ORR', 'ADDR', 'SUBR', 'ANDNR')


def generated_sequence(rng: random.Random, max_ops: int) -> isa.Seq:
    """A small common-subset program accepted by both listing emitters."""
    seq = isa.Seq()
    current = 0
    recent = [0]
    for _ in range(rng.randint(1, max_ops)):
        family = rng.randrange(10)
        if family < 4:
            op = rng.choice(IMMEDIATE)
            constant = rng.choice(CONSTANTS) if rng.randrange(3) \
                else rng.getrandbits(64)
            current = seq.emit(op, [current], const=constant)
        elif family < 6:
            current = seq.emit(rng.choice(SHIFT), [current],
                               shift=rng.randrange(64))
        elif family < 7:
            current = seq.emit(rng.choice(UNARY), [current])
        else:
            other = rng.choice(recent[-5:])
            current = seq.emit(rng.choice(BINARY), [current, other])
        recent.append(current)
    seq.result = current
    return seq


def _table(function, input_bits: int) -> tuple[int, ...]:
    return tuple(function(value) & M64 for value in range(1 << input_bits))


def _wasm_target(result):
    return next(target for target in result.get('targets', ())
                if target['name'] == 'wasm32' and target.get('ok'))


def _artifact(result) -> bytes:
    target = _wasm_target(result)
    return run.artifact_for(target['seq'], result['semantics']['input_bits'],
                            result['semantics']['output_bits'])


def _native_module():
    source = Path(__file__).resolve().parents[2] / 'v1' / 'x86_oracle.py'
    spec = importlib.util.spec_from_file_location('qm_v1_x86_oracle', source)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _check_native(text: str, expected: tuple[int, ...]) -> None:
    oracle_module = _native_module()
    with tempfile.TemporaryDirectory(prefix='qm-fuzz-native-') as directory:
        source = Path(directory) / 'case.s'
        source.write_text(text, encoding='utf-8', newline='\n')
        abi = oracle_module.FunctionABI(('u64',), 'u64')
        with oracle_module.X86ExecutionOracle(
                source, 'qm_fuzz', abi, timeout=2) as oracle:
            got = tuple(oracle(value) & M64 for value in range(len(expected)))
    if got != expected:
        value = next(i for i, pair in enumerate(zip(got, expected))
                     if pair[0] != pair[1])
        raise AssertionError('native x86 mismatch at input 0x%X' % value)


def check_case(seq: isa.Seq, input_bits: int, *, solve_case=False,
               native_x86=False) -> bool:
    """Check one generated function at every enabled boundary."""
    reference = _table(isa.compile_seq(seq), input_bits)
    local = isa._normalize_local(seq)
    normalized = isa.normalize(seq)
    if _table(isa.compile_seq(normalized), input_bits) != reference:
        raise AssertionError('normalization changed the function')
    if isa._shape(isa.normalize(normalized)) != isa._shape(normalized):
        raise AssertionError('normalization did not reach a fixed point')

    x86_text = isa.emit_asm(normalized, 'qm_fuzz', input_bits)
    wasm_text = isa.emit_wasm(normalized, 'qm_fuzz', input_bits)
    if x86_text is None or wasm_text is None:
        raise AssertionError('the common-subset generator emitted an unsupported op')

    x86_function, x86_dialect = parse(x86_text)
    wasm_function, wasm_dialect = parse(wasm_text)
    if (x86_dialect, wasm_dialect) != ('x86-64', 'wasm32'):
        raise AssertionError('listing detection disagreed')

    for label, got in (
            ('x86-64 reader', _table(x86_function, input_bits)),
            ('wasm32 reader', _table(wasm_function, input_bits))):
        if got != reference:
            value = next(i for i, pair in enumerate(zip(got, reference))
                         if pair[0] != pair[1])
            raise AssertionError('%s mismatch at input 0x%X' % (label, value))

    if native_x86:
        _check_native(x86_text, reference)

    if solve_case:
        from_x86 = solve(x86_text, options={'input_bits': input_bits})
        from_wasm = solve(wasm_text, options={'input_bits': input_bits})
        if not from_x86.get('ok') or not from_wasm.get('ok'):
            raise AssertionError('a generated listing did not solve')
        for label, result in (('x86-64 QM', from_x86),
                              ('wasm32 QM', from_wasm)):
            got = _table(isa.compile_seq(_wasm_target(result)['seq']),
                         input_bits)
            if got != reference:
                raise AssertionError('%s changed the function' % label)
        if _artifact(from_x86) != _artifact(from_wasm):
            raise AssertionError('the two input paths produced different codecs')
    return isa.objective_key(normalized) < isa.objective_key(local)


def fuzz(cases: int, seed: int, input_bits: int = 8, max_ops: int = 12,
         solve_cases: int = 8, native_x86: bool = False) -> int:
    rng = random.Random(seed)
    completed = 0
    attempts = 0
    improved = 0
    while completed < cases:
        attempts += 1
        seq = generated_sequence(rng, max_ops)
        # Extreme register pressure is outside the small emitter's contract.
        # Regenerate instead of quietly turning a missing listing into a pass.
        normalized = isa.normalize(seq)
        if isa.emit_asm(normalized, 'qm_fuzz', input_bits) is None:
            continue
        try:
            improved += check_case(seq, input_bits,
                                   solve_case=completed < solve_cases,
                                   native_x86=native_x86)
        except Exception as exc:
            print('seed=%d case=%d attempts=%d' % (seed, completed, attempts))
            print('sequence=%r result=%d' % (seq.ins, seq.result))
            print(isa.emit_asm(normalized, 'qm_fuzz', input_bits) or '<no x86>')
            print(isa.emit_wasm(normalized, 'qm_fuzz', input_bits) or '<no wasm>')
            raise AssertionError('fuzz failure: %s' % exc) from exc
        completed += 1
    return improved


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cases', type=int, default=200)
    parser.add_argument('--seed', type=int, default=0x51A7E)
    parser.add_argument('--input-bits', type=int, default=8, choices=range(1, 17))
    parser.add_argument('--max-ops', type=int, default=12)
    parser.add_argument('--solve-cases', type=int, default=8)
    parser.add_argument('--native-x86', action='store_true')
    args = parser.parse_args()
    if args.cases < 1 or args.max_ops < 1 or args.solve_cases < 0:
        parser.error('cases and max-ops must be positive; solve-cases nonnegative')
    improved = fuzz(args.cases, args.seed, args.input_bits, args.max_ops,
                    min(args.solve_cases, args.cases), args.native_x86)
    print('ok: %d cases, seed=%d, %d full QM round trips, '
          '%d improved by whole-expression extraction%s'
          % (args.cases, args.seed, min(args.solve_cases, args.cases),
             improved, ', native x86 checked' if args.native_x86 else ''))


if __name__ == '__main__':
    main()
