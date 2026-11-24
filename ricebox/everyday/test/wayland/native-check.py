import hashlib, os, select, struct, subprocess, tempfile, sys
from pathlib import Path

def until(proc, needle):
    data = bytearray()
    for _ in range(4000):
        rd, _, _ = select.select([proc.stdout], [], [], 2)
        if not rd: raise TimeoutError((needle, bytes(data)))
        b = os.read(proc.stdout.fileno(), 1)
        if not b: raise RuntimeError((needle, bytes(data), proc.poll(), proc.stderr.read()))
        data.extend(b)
        if b == b'\n' and data.decode().splitlines()[-1].startswith(needle): return data.decode()
    raise OverflowError(data)

def frame(path, seq, w, h, pixel):
    b=path.read_bytes()
    assert b[:4] == b'RBF1' and len(b)==16+w*h*4
    assert struct.unpack('<III',b[4:16])==(seq,w,h)
    at=16+4*(10+12*w)
    assert tuple(b[at:at+4])==pixel
    assert tuple(b[16:20])==(18,28,42,255)
    for y in range(h):
        for x in range(w):
            i=16+4*(x+y*w)
            expected=(248,61,105,255) if seq==2 and (x-10)**2+(y-12)**2<=4 else (18+2*x,28+3*y,42+(x^y),255)
            assert tuple(b[i:i+4])==expected,(x,y,tuple(b[i:i+4]),expected)
    print('FRAME_SHA',seq,hashlib.sha256(b[16:]).hexdigest())
    return b

with tempfile.TemporaryDirectory(prefix='wayland-proof-') as td:
    path=Path(td)/'frame.rgba'
    p=subprocess.Popen([sys.argv[1],td,*sys.argv[2:]],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,bufsize=0)
    lines=[]
    def observe(chunk):
        print(chunk,end='')
        lines.extend(chunk.splitlines())
    try:
        first=until(p,'WAYLAND_COMMIT seq=1')
        observe(first)
        assert ('WAYLAND_CLIENT_EXEC fd_inherited=1 cloexec_sentinel_absent=1 stdin_absent=1' in first)==bool(sys.argv[2:])
        assert ('WAYLAND_SOCKET_CONSUMED close_on_exec=1' in first)==bool(sys.argv[2:])
        frame(path,1,32,24,(38,64,48,255))
        p.stdin.write(bytes([1,250,250]))
        observe(until(p,'WAYLAND_CONTROL_REFUSED'))
        assert struct.unpack('<I',path.read_bytes()[4:8])==(1,)
        p.stdin.write(bytes([1,10,12]))
        observe(until(p,'WAYLAND_COMMIT seq=2'))
        frame(path,2,32,24,(248,61,105,255))
        p.stdin.write(bytes([2,47,19]))
        observe(until(p,'WAYLAND_COMMIT seq=3'))
        final=frame(path,3,47,19,(38,64,48,255))
        p.stdin.write(bytes([3,0,0]))
        out,err=p.communicate(timeout=4)
        observe(out.decode())
        assert p.returncode==37 and not err,(p.returncode,out,err)
        lifecycle=[line for line in lines if line.startswith(('WAYLAND_COMMIT ', 'WAYLAND_RELEASE '))]
        assert len(lifecycle)==6,lifecycle
        for i,kind in enumerate(('new', 'reused', 'new')):
            assert lifecycle[2*i].startswith(f'WAYLAND_COMMIT seq={i+1} '),lifecycle
            assert lifecycle[2*i+1]==f'WAYLAND_RELEASE seq={i+1} buffer={kind}',lifecycle
        assert lines[-2:]==['WAYLAND_CLIENT pointer=1 configure=2 frame_done=3 releases=3',
                            'WAYLAND_WINDOW_CLOSED'],lines
        assert path.read_bytes()==final,'close must not publish another frame'
        print('NATIVE_WAYLAND_3_EXPORTED_COMMITS_OK')
    finally:
        if p.poll() is None: p.kill(); p.wait(timeout=4)
