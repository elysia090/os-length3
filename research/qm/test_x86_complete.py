#!/usr/bin/env python3
import importlib.util
import os
import random
import subprocess
import tempfile
from pathlib import Path

ROOT=Path('/mnt/data/qm_e2e')
FULL=Path('/mnt/data/qm-prototype-x86-complete.py')

spec=importlib.util.spec_from_file_location('qmfull', FULL)
qm=importlib.util.module_from_spec(spec); spec.loader.exec_module(qm)

# Existing exact interpreter regression.
subprocess.run(['python3', str(ROOT/'test_frontend.py')], check=True)

# End-to-end existing QM case must stay exact.
res,sem=qm.synth_from_x86(ROOT/'kernels.s','ranks8_ref',range(256),arg='u8',ret='u64')
prog,freedom,err=res
assert err is None and freedom==502
assert prog[0]==('LIN_CONST',0x0101010101010101)
assert prog[1]==('CONV_Z',0x0101010101010100)
assert sem.backend=='python-interpreter'

# Unknown-to-Python CRC32 must automatically fall back to the execution oracle.
sem=qm.extract_unary_x86_semantics(ROOT/'oracle_fallback.s','crc8_fold',range(256),arg='u8',ret='u32',backend='auto')
assert sem.backend=='execution-oracle'
assert sem(0)==0 and sem(1)==0xF26B8303

# Native-oracle instruction/ABI coverage.
abi=qm.FunctionABI(('v512','v512','v512'),'v512')
with qm.X86ExecutionOracle(ROOT/'oracle_isa_tests.s','avx512_xor3',abi) as o:
    for _ in range(30):
        a=os.urandom(64); b=os.urandom(64); c=os.urandom(64)
        assert o(a,b,c)==bytes(x^y^z for x,y,z in zip(a,b,c))

abi=qm.FunctionABI(('v512','v512'),'u64')
with qm.X86ExecutionOracle(ROOT/'oracle_isa_tests.s','avx512_cmpmask',abi,cflags=['-mavx512bw']) as o:
    for _ in range(20):
        a=os.urandom(64); b=os.urandom(64)
        ref=sum((x<y)<<i for i,(x,y) in enumerate(zip(a,b)))
        assert o(a,b)==ref

abi=qm.FunctionABI(('v128','v128'),'v128')
with qm.X86ExecutionOracle(ROOT/'oracle_isa_tests.s','aes_round_zero',abi) as o:
    assert o(bytes(16),bytes(16))==bytes([0x63])*16

abi=qm.FunctionABI(('u64',),'u64')
with qm.X86ExecutionOracle(ROOT/'oracle_isa_tests.s','rip_const_loop',abi) as o:
    def rol(x,c): return ((x<<c)|(x>>(64-c)))&((1<<64)-1)
    for x in [0,1,0x123456789abcdef0,(1<<64)-1]:
        r=0x9e3779b97f4a7c15^x
        for _ in range(7): r=(rol(r,9)+x)&((1<<64)-1)
        assert o(x)==r

abi=qm.FunctionABI(('u64','u64'),'u64','ms')
with qm.X86ExecutionOracle(ROOT/'oracle_isa_tests.s','msabi_mix',abi) as o:
    a=0x123456789abcdef0; b=0xfedcba9876543210
    ref=(((a<<13)|(a>>(64-13)))&((1<<64)-1))^b
    assert o(a,b)==ref

# Pointer in/out semantics through the ordinary compiler asm.
abi=qm.FunctionABI(('inout:32','u64'),'u64')
with qm.X86ExecutionOracle(ROOT/'frontend_tests.s','store_mix',abi) as o:
    data=bytes(range(32)); x=0x1122334455667788
    ret,after=o(data,x)
    assert ret==0x77 and after[5:13]==x.to_bytes(8,'little')

# x87 long double exact 80-bit payload.
zero=bytes(10); one=bytes.fromhex('0000000000000080ff3f')
abi=qm.FunctionABI(('f80',),'f80')
with qm.X86ExecutionOracle(ROOT/'x87_test.s','x87_inc',abi) as o:
    assert o(zero)==one

# 128-bit integer return (RDX:RAX in SysV).
abi=qm.FunctionABI(('u64','u64'),'u128')
with qm.X86ExecutionOracle(ROOT/'u128_test.s','mul128',abi) as o:
    a=(1<<64)-1; b=0x123456789abcdef0
    assert o(a,b)==a*b

# Relocatable object input bypasses local asm parsing entirely.
obj=ROOT/'oracle_isa_tests.o'
if not obj.exists():
    subprocess.run(['clang','-c',str(ROOT/'oracle_isa_tests.s'),'-o',str(obj)],check=True)
abi=qm.FunctionABI(('u64',),'u64')
with qm.X86ExecutionOracle(obj,'rip_const_loop',abi) as o:
    assert isinstance(o(123),int)

# Purity policy rejects syscall by default and strict seccomp kills it even if
# the caller explicitly opts into impure execution.
abi=qm.FunctionABI((),'u64')
try:
    qm.X86ExecutionOracle(ROOT/'oracle_isa_tests.s','do_getpid',abi)
    raise AssertionError('syscall should be rejected by purity policy')
except qm.OracleError as e:
    assert 'pure-semantics policy' in str(e)

try:
    with qm.X86ExecutionOracle(ROOT/'oracle_isa_tests.s','do_getpid',abi,allow_impure=True,timeout=1) as o:
        o()
    raise AssertionError('strict seccomp should kill syscall')
except qm.OracleError:
    pass

print('complete x86-64 frontend regression OK')
