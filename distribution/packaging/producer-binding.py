#!/usr/bin/env python3
"""Check exact producer/reproduction/output correlations from trusted local runs.

Checking unsigned files establishes consistency, not their publisher authority.
"""
import hashlib
import json
from pathlib import Path
import sys


def digest(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as stream:
        while block:=stream.read(1048576):h.update(block)
    return h.hexdigest()


def decode(data):
    def pairs(rows):
        out={}
        for key,value in rows:
            if key in out:raise ValueError('duplicate binding field')
            out[key]=value
        return out
    return json.loads(data,object_pairs_hook=pairs)


def read(path):
    return decode(Path(path).read_bytes())


def check(reproduction,executed,events,toolchain,candidate,artifacts):
    for cut in [reproduction,executed]:
        if cut['format']!='fixed-native-producer-cut-v1' or cut['cleanReplicas']!=2:
            raise ValueError('two clean producer replicas required')
    if reproduction['producers']!=executed['producers']:
        raise ValueError('executed producers differ from reproduced source cut')
    for field in ['sourceArchiveSha256','bootstrapIdentity','conditions']:
        if reproduction[field]!=executed[field]:raise ValueError('source/toolchain/build conditions differ')
    expected={'compiler','verifier','stage','audit','archive'}
    if set(reproduction['producers'])!=expected:raise ValueError('complete producer population required')
    population=read(toolchain)
    if digest(toolchain)!=reproduction['toolchainFilesSha256'] or len(population)!=reproduction['toolchainFiles']:
        raise ValueError('fixed toolchain file population differs')
    counts={role:0 for role in expected}
    for row in events:
        role=row['role']
        if role not in expected or row['producer']!=executed['producers'][role] or row['exit']!=0 or row['execution']!='read-only-fexecve':
            raise ValueError('unmatched or failed producer execution')
        counts[role]+=1
    if not all(counts.values()):raise ValueError('actual execution absent for a producer role')
    for role,file in [('kernel','kernel'),('initramfs','initramfs'),('system','system.squashfs')]:
        path=Path(artifacts)/file;expected_object=candidate['objects'][role]
        if path.stat().st_size!=expected_object['bytes'] or digest(path)!=expected_object['sha256']:
            raise ValueError('reproduced output differs from final candidate: '+role)
    return counts


if __name__=='__main__':
    try:
        if len(sys.argv)!=8:raise ValueError('usage: producer-binding.py REPRODUCTION-CUT EXECUTION-CUT EXECUTION-LOG TOOLCHAIN-FILES CANDIDATE ARTIFACT-DIRECTORY EXPECTED-CANDIDATE-SHA256')
        reproduction,executed=map(read,sys.argv[1:3])
        events=[decode(line) for line in Path(sys.argv[3]).read_text().splitlines()]
        if any(e['cutSha256']!=digest(sys.argv[2]) for e in events):raise ValueError('execution cut digest differs')
        if digest(sys.argv[5])!=sys.argv[7]:raise ValueError('expected final candidate pin differs')
        counts=check(reproduction,executed,events,sys.argv[4],read(sys.argv[5]),sys.argv[6])
        print(json.dumps({'status':'pass','actualExecutions':counts,'scope':'fixed source/toolchain/build conditions, actual descriptor execution, exact final candidate root bytes; unsigned local runner evidence'}))
    except (ValueError,KeyError,OSError,TypeError) as error:
        print(str(error),file=sys.stderr);sys.exit(2)
