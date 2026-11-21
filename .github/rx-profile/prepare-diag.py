#!/usr/bin/env python3
"""Apply three verified scratch observation hooks. No replacement of guest code bytes."""
import hashlib,pathlib,sys
p=pathlib.Path(sys.argv[1])/'ricebox/sods/runtime/linux/process.ts'
b=p.read_bytes()
if hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()!='5f5666fe3086fa1a797c131cbd5ee0c8be92c62c': raise SystemExit('unapproved process.ts')
hooks=[
 (b'x.run(t.resumeAt);', b'globalThis.__riceboxTrace.dispatch(t, x);'),
 (b'const image = new Image(new WebAssembly.Module(wasm), () => bytes, wasm.length, segments);\n    PROFILE.compile += steady() - t; PROFILE.images++;\n', b'const image = new Image(new WebAssembly.Module(wasm), () => bytes, wasm.length, segments);\n    PROFILE.compile += steady() - t; PROFILE.images++;\n    globalThis.__riceboxTrace.observe(node, revision, image, wasm);\n'),
 (b'PROFILE.compile += steady() - t; PROFILE.images++; PROFILE.consolidated++;\n', b'PROFILE.compile += steady() - t; PROFILE.images++; PROFILE.consolidated++;\n    globalThis.__riceboxTrace.observe(_node, cached.version, image, wasm);\n'),
]
for old,new in hooks:
 if b.count(old)!=1: raise SystemExit('observation anchor mismatch')
 b=b.replace(old,new)
p.write_bytes(b)
