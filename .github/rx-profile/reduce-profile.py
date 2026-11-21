#!/usr/bin/env python3
"""Post-observation ownership index. Inputs remain runner-local."""
import hashlib,json,pathlib,subprocess,sys
d=pathlib.Path(sys.argv[1]);elf=pathlib.Path(sys.argv[2]);node=sys.argv[3];p=pathlib.Path(__file__).parent
holder=json.loads((d/'holder.json').read_text());expect=hashlib.sha256(elf.read_bytes()).hexdigest();assert holder['extras']['compilerSha']==expect
maps=[]
for m in holder['extras']['maps']:
 name=m['wasm'];assert m['elf']==expect and len(name)==64 and all(c in '0123456789abcdef' for c in name)
 stem=d/('module-'+name);blob=stem.with_suffix('.wasm');ix=stem.with_suffix('.index.json')
 ix.write_bytes(subprocess.check_output([node,p/'index-module.ts',blob]))
 mp=stem.with_suffix('.map.json')
 mp.write_bytes(subprocess.check_output(['python3','-B',p/'index-elf.py',elf,ix,expect,name,'--bias',m['bias'],'--bias-source','loaded Image.facts.entry minus exact native ELF e_entry, exact lowering commit check']))
 maps.append(mp)
assert maps
kid=subprocess.check_output(['python3','-B',p/'reduce.py',d/'holder.json',d/'trace.json',*maps])
r=json.loads(kid);assert r['rows'] and all(z['phase']=='changed-source-template-TU' and z['elfSha256']==expect for z in r['rows'])
# Still private. Publish only a fixed, bounded aggregate in aggregate.py.
(d/'reduced.json').write_bytes(kid)
