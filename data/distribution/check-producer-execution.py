#!/usr/bin/env python3
"""Exercise native descriptor binding in a disposable private mount namespace."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

helper=Path(__file__).with_name('producer-execution.py')
spec=importlib.util.spec_from_file_location('producer_execution',helper)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
if os.name!='posix':
    print('producer descriptor integration: not-tested (native Linux required)')
    if '--require-native' in sys.argv:sys.exit(2)
    sys.exit(0)
with tempfile.TemporaryDirectory(prefix='qm-producer-execution-') as directory:
    root=Path(directory);cut=root/'cut';cut.mkdir()
    program=cut/'producer';shutil.copyfile('/bin/true',program);program.chmod(0o555)
    data=program.read_bytes();identity={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
    manifest=cut/'manifest.json';manifest.write_text(json.dumps({'format':'fixed-native-producer-cut-v1','producers':{'test':identity}}))
    log=root/'execution.jsonl'
    argv=[sys.executable,str(helper),'run',str(manifest),str(log),'test',str(program)]
    result=subprocess.run(argv,capture_output=True,text=True)
    assert result.returncode==2 and 'read-only' in result.stderr and not log.exists()
    script='set -eu\nmount --bind "$1" "$1"\nmount -o remount,bind,ro "$1"\nshift\n"$@"\n'
    result=subprocess.run(['unshare','--mount','--propagation','private','sh','-c',script,'fixture',str(cut),*argv],capture_output=True,text=True)
    if result.returncode!=0:raise RuntimeError(result.stderr)
    row=json.loads(log.read_text());assert row['producer']==identity and row['exit']==0 and row['execution']=='read-only-fexecve'
    saved=log.read_bytes();shutil.copyfile('/bin/false',program)
    result=subprocess.run(argv,capture_output=True,text=True)
    assert result.returncode==2 and 'differs' in result.stderr and log.read_bytes()==saved
    manifest.write_text('{"format":"fixed-native-producer-cut-v1","format":"different"}')
    result=subprocess.run(argv,capture_output=True,text=True)
    assert result.returncode==2 and 'duplicate' in result.stderr and log.read_bytes()==saved
    script_file=cut/'script';script_file.write_text('#!/bin/sh\nexit 0\n');script_file.chmod(0o555)
    fd=os.open(script_file,os.O_RDONLY)
    try:
        try:module.inspect(fd);raise AssertionError('script accepted as native producer')
        except ValueError as error:assert 'ELF' in str(error)
    finally:os.close(fd)
print('producer descriptor execution: pass (actual ELF, writable cut refusal, substituted producer, duplicate manifest, script refusal)')
