#!/usr/bin/env python3
"""Produce only the authenticated historical BusyBox subtree, not a rebuilt APK."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile

RELEASE = "ec84d6a4f34359f322726e323e294b03987a19b1aa544563c846ca1a83060ee3"
INPUT_BYTES = 115302848
BUSYBOX = "5b10f1705ad5250b74aa56548d72263db52c9737061db005c8186c8c295e4d63"
SOURCE = "b8cc24c9574d809e7279c3be349795c5d5ceb6fdf19ca709f80cde50e47de314"
KEY = "d207560d09c57646cd62c755e39c90b5e7e1f6488416962f35f996452e840693"
HEAD = "28c45a65649b1058da0ad5077624e8fd4fa3cee9"

def norm(name):
    p=PurePosixPath(name)
    assert not p.is_absolute() and '..' not in p.parts and str(p)==name
    return name

def unpack(archive):
    # The full archive has been authenticated first. Only regular/symlink
    # records on an explicitly bounded package-owned allowlist are copied.
    with subprocess.Popen(['zstd','-dc','--',str(archive)],stdout=subprocess.PIPE) as proc:
        try:
            with tarfile.open(fileobj=proc.stdout,mode='r|') as tar:
                for member in tar:
                    yield tar,member
            while proc.stdout.read(1<<20):
                pass
        finally:
            proc.stdout.close()
        assert proc.wait()==0

def selected_apk_db(db):
    groups=[p.splitlines() for p in db.split('\n\n') if 'P:busybox' in p.splitlines()]
    assert len(groups)==1
    group=groups[0]
    assert all(x in group for x in ['P:busybox','V:1.36.1-r0','A:x86_64'])
    owners={}
    dirname=None
    path=None
    for line in group:
        if line.startswith('F:'):
            dirname=norm(line[2:])
            path=None
        elif line.startswith('R:'):
            assert dirname in ('usr/bin','usr/sbin')
            path=norm(dirname+'/'+line[2:])
            assert len(PurePosixPath(path).parts)==3 and path not in owners
            owners[path]=None
        elif line.startswith('Z:'):
            assert path and owners[path] is None and re.fullmatch(r'Q1[A-Za-z0-9+/]{27}=',line[2:])
            owners[path]=line[2:]
    assert 100<len(owners)<250 and len(set(owners.values()))>=2 and all(owners.values())
    assert 'usr/bin/busybox' in owners and 'usr/bin/sh' in owners
    return owners

def main(archive,out):
    assert archive.is_file() and archive.stat().st_size==INPUT_BYTES
    with archive.open('rb') as f:
        assert hashlib.file_digest(f,'sha256').hexdigest()==RELEASE
    record=''
    manifest=''
    for tar,member in unpack(archive):
        if member.name=='manifest':
            assert not manifest and member.isreg() and member.size<1<<20
            manifest=tar.extractfile(member).read().decode()
        if member.name=='root/usr/lib/apk/db/installed':
            assert not record and member.isreg() and member.size<10<<20
            record=tar.extractfile(member).read().decode()
    assert f'package.busybox=1.36.1 {SOURCE} {KEY}' in manifest.splitlines()
    owners=selected_apk_db(record)
    tree=out/'busybox'/'tree'
    (tree/'usr'/'bin').mkdir(parents=True,mode=0o755)
    (tree/'usr'/'sbin').mkdir(mode=0o755)
    items={}
    for tar,m in unpack(archive):
        if not m.name.startswith('root/') or m.name[5:] not in owners:
            continue
        name=norm(m.name[5:])
        assert name not in items and m.uid==m.gid==0
        path=tree/name
        if name=='usr/bin/busybox':
            assert m.isreg() and m.mode==0o755 and 0<m.size<1<<20
            data=tar.extractfile(m).read()
            assert hashlib.sha256(data).hexdigest()==BUSYBOX
            path.write_bytes(data)
            path.chmod(m.mode)
            item={'kind':'file','bytes':len(data),'mode':'0755','sha256':BUSYBOX}
        else:
            expected_link='busybox' if name.startswith('usr/bin/') else '../bin/busybox'
            assert m.issym() and m.linkname==expected_link
            data=m.linkname.encode()
            path.symlink_to(m.linkname)
            item={'kind':'symlink','target':m.linkname}
        assert 'Q1'+base64.b64encode(hashlib.sha1(data).digest()).decode()==owners[name]
        items[name]=item
    assert items.keys()==owners.keys()
    for label,value in [('version','1.36.1'),('source',SOURCE),('key',KEY)]:
        (out/'busybox'/label).write_text(value+'\n')
    (out/'busybox'/'url').write_text('https://busybox.net/downloads/busybox-1.36.1.tar.bz2\n')
    return {'scope':'derived authenticated publisher archive package, not fresh Alpine build',
            'source_revision_context':HEAD,'published_root_sha256':RELEASE,
            'published_root_bytes':INPUT_BYTES,'upstream_source_sha256':SOURCE,
            'package_key_from_published_manifest':KEY,'package_entries':len(items),
            'checksums_verified':len(items),'elf':items['usr/bin/busybox'],
            'symlinks_to_authenticated_elf':len(items)-1}

if __name__=='__main__':
    if not __debug__:
        raise SystemExit("Refusing to disable authentication assertions")
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('published_archive',type=Path)
    p.add_argument('new_packages',type=Path)
    args=p.parse_args()
    assert not os.path.lexists(args.new_packages)
    args.new_packages.mkdir(mode=0o755)
    print(json.dumps(main(args.published_archive,args.new_packages),sort_keys=True))
