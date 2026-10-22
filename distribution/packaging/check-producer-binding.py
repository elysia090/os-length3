#!/usr/bin/env python3
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile

path=Path(__file__).with_name('producer-binding.py');spec=importlib.util.spec_from_file_location('binding',path)
binding=importlib.util.module_from_spec(spec);spec.loader.exec_module(binding)
with tempfile.TemporaryDirectory(prefix='qm-producer-binding-') as directory:
    root=Path(directory).resolve(strict=True)
    assert root.is_relative_to(Path(tempfile.gettempdir()).resolve(strict=True)) and root.name.startswith('qm-producer-binding-')
    tc=root/'toolchain.json';tc.write_bytes(b'{"/tool":{"bytes":1,"sha256":"fixture"}}\n')
    roles=['compiler','verifier','stage','audit','archive']
    cut={'format':'fixed-native-producer-cut-v1','cleanReplicas':2,'producers':{r:{'bytes':1,'sha256':r} for r in roles},
         'sourceArchiveSha256':'fixed-source','bootstrapIdentity':'fixed-bootstrap','conditions':{'CFLAGS':'-O2'},
         'toolchainFiles':1,'toolchainFilesSha256':binding.digest(tc)}
    candidate={'objects':{}}
    for role,file in [('kernel','kernel'),('initramfs','initramfs'),('system','system.squashfs')]:
        data=('fixture-'+role).encode();(root/file).write_bytes(data)
        candidate['objects'][role]={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
    events=[{'role':r,'producer':cut['producers'][r],'exit':0,'execution':'read-only-fexecve'} for r in roles]
    assert binding.check(cut,cut,events,tc,candidate,root)==dict.fromkeys(roles,1)
    failures=0
    def refuse(reproduced,executed,rows):
        global failures
        try:binding.check(reproduced,executed,rows,tc,candidate,root);raise AssertionError('invalid binding accepted')
        except ValueError:failures+=1
    for field in ['sourceArchiveSha256','bootstrapIdentity','conditions','producers']:
        changed=copy.deepcopy(cut);changed[field]={'different':True};refuse(cut,changed,events)
    for key,value in [('exit',1),('execution','path-only'),('producer',{'bytes':2,'sha256':'different'})]:
        rows=copy.deepcopy(events);rows[0][key]=value;refuse(cut,cut,rows)
    refuse(cut,cut,events[:-1])
    changed=copy.deepcopy(cut);changed['cleanReplicas']=1;refuse(changed,cut,events)
    previous=tc.read_bytes();tc.write_bytes(previous+b' ');refuse(cut,cut,events);tc.write_bytes(previous)
    previous=(root/'kernel').read_bytes();(root/'kernel').write_bytes(previous+b'x');refuse(cut,cut,events);(root/'kernel').write_bytes(previous)
    try:binding.decode('{"exit":1,"exit":0}');raise AssertionError('duplicate execution field accepted')
    except ValueError:failures+=1
print(f'producer binding consistency: pass ({failures} counterexamples; synthetic records do not prove trusted execution)')
