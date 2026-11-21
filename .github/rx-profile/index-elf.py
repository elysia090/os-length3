#!/usr/bin/env python3
"""Join guest FUNCTION ENTRY (not sampled instruction address) with executable segments and unique STT_FUNC ranges."""
import argparse, bisect, hashlib, json, pathlib, re, subprocess
p=argparse.ArgumentParser();p.add_argument('elf',type=pathlib.Path);p.add_argument('input',type=pathlib.Path);p.add_argument('expected_elf_sha256');p.add_argument('expected_wasm_sha256');p.add_argument('--bias',required=True,type=lambda s:int(s,0));p.add_argument('--bias-source',required=True);a=p.parse_args()
sha=hashlib.sha256(a.elf.read_bytes()).hexdigest();m=json.loads(a.input.read_text());assert sha==a.expected_elf_sha256 and m['sha']==a.expected_wasm_sha256 and a.bias_source
arg=str(a.elf); elf=subprocess.check_output(['readelf','-lWh',arg],text=True);assert 'Advanced Micro Devices X86-64' in elf
seg=[]
for l in elf.splitlines():
 z=l.split()
 if z and z[0]=='LOAD' and 'E' in ''.join(z[6:-1]): seg.append(tuple(int(z[n],16) for n in [2,4,1]))
assert seg
# Raw ELF alone supplies names when not stripped, otherwise unresolved unless matching debug is separately provided and strictly checked.
syms={}
for l in subprocess.check_output(['readelf','-Ws',arg],text=True).splitlines():
 z=l.split()
 if len(z)>=8 and z[0].endswith(':') and z[3] in ('FUNC','IFUNC') and z[6].isdigit() and int(z[2],0)>0:
  v,n=int(z[1],16),int(z[2],0)
  if any(s<=v and v+n<=s+k for s,k,o in seg): syms.setdefault((v,v+n),set()).add(z[7])
rr=sorted((v,b,sorted(ns)) for (v,b),ns in syms.items()); pos=[v for v,b,ns in rr]; maxend=[];h=0
for v,b,ns in rr: h=max(h,b);maxend.append(h)
for r in m['rows']:
 if r['guest'] is None:continue
 v=int(r['guest'],16)-a.bias; segs=[(s,o) for s,k,o in seg if s<=v<s+k]
 if len(segs)!=1: r['elf']={'unknown':'no unique executable PT_LOAD'};continue
 j=bisect.bisect_right(pos,v)-1; own=[]
 while j>=0 and maxend[j]>v:
  if rr[j][0]<=v<rr[j][1]:own.append(rr[j])
  j-=1
 r['elf']={'vma':hex(v),'fileOffset':hex(segs[0][1]+v-segs[0][0]),'symbol':own[0][2][0] if len(own)==1 and len(own[0][2])==1 else None,'candidates':own}
m.update({'elfSha':sha,'bias':hex(a.bias),'biasProvenance':a.bias_source});print(json.dumps(m))
