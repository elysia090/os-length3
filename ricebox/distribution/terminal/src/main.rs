//! The caller starts the box; prompt attaches only its terminal descriptor: prompt attach FD.
use std::{collections::VecDeque, io, mem, os::fd::RawFd, process::ExitCode};
const ROOM: usize = 64 << 10;

struct Terminal { peer: RawFd, signals: RawFd, peer_flags: i32, output_flags: i32, original: Option<libc::termios> }
impl Drop for Terminal {
    fn drop(&mut self) {
        // The caller retains the open-file descriptions. Restore their flags and the frontend's terminal mode.
        unsafe {
            if let Some(mode)=&self.original { libc::tcsetattr(0,libc::TCSANOW,mode); }
            if self.peer_flags>=0 { libc::fcntl(self.peer,libc::F_SETFL,self.peer_flags); }
            if self.output_flags>=0 { libc::fcntl(1,libc::F_SETFL,self.output_flags); }
            if self.signals>=0 { libc::close(self.signals); }
            libc::close(self.peer);
        }
    }
}
fn check(result:i32)->io::Result<()> { if result<0 {Err(io::Error::last_os_error())} else {Ok(())} }
impl Terminal {
    fn attach(peer:RawFd)->io::Result<Self> {
        // Every unsafe call below is at the OS boundary, with live local structs/buffers and checked fd results.
        unsafe {
            let mut mode=mem::zeroed::<libc::termios>(); check(libc::tcgetattr(peer,&mut mode))?;
            let mut terminal=Self{peer,signals:-1,peer_flags:-1,output_flags:-1,original:None};
            let mut mask=mem::zeroed::<libc::sigset_t>(); check(libc::sigemptyset(&mut mask))?;
            for signal in [libc::SIGHUP,libc::SIGINT,libc::SIGTERM,libc::SIGWINCH,libc::SIGPIPE] {check(libc::sigaddset(&mut mask,signal))?;}
            check(libc::sigprocmask(libc::SIG_BLOCK,&mask,std::ptr::null_mut()))?;
            terminal.signals=libc::signalfd(-1,&mask,libc::SFD_CLOEXEC|libc::SFD_NONBLOCK);check(terminal.signals)?;
            terminal.peer_flags=libc::fcntl(peer,libc::F_GETFL);check(terminal.peer_flags)?;
            terminal.output_flags=libc::fcntl(1,libc::F_GETFL);check(terminal.output_flags)?;
            check(libc::fcntl(peer,libc::F_SETFL,terminal.peer_flags|libc::O_NONBLOCK))?;
            check(libc::fcntl(1,libc::F_SETFL,terminal.output_flags|libc::O_NONBLOCK))?;
            if libc::tcgetattr(0,&mut mode)==0 {
                terminal.original=Some(mode);libc::cfmakeraw(&mut mode);check(libc::tcsetattr(0,libc::TCSANOW,&mode))?;
                terminal.resize();
            }
            Ok(terminal)
        }
    }
    fn resize(&self) {
        unsafe { let mut size=mem::zeroed::<libc::winsize>();
            if libc::ioctl(0,libc::TIOCGWINSZ,&mut size)==0 {libc::ioctl(self.peer,libc::TIOCSWINSZ,&size);}
        }
    }
    fn signal(&self)->io::Result<Option<u8>> {
        let mut signal=unsafe{mem::zeroed::<libc::signalfd_siginfo>()};
        let count=unsafe{libc::read(self.signals,(&mut signal as *mut libc::signalfd_siginfo).cast(),mem::size_of_val(&signal))};
        if count<0 {let e=io::Error::last_os_error(); if e.kind()==io::ErrorKind::WouldBlock {return Ok(None)} return Err(e)}
        if count as usize!=mem::size_of_val(&signal) {return Err(io::Error::other("short signal record"))}
        if signal.ssi_signo as i32==libc::SIGWINCH {self.resize();Ok(None)} else {Ok(Some(128+signal.ssi_signo as u8))}
    }
    fn run(&self)->io::Result<u8> {
        let mut input=VecDeque::with_capacity(ROOM);let mut output=VecDeque::with_capacity(ROOM);
        let (mut typing,mut peer_open,mut eof,mut peer_hup)=(true,true,false,false);
        loop {
            if eof && peer_open && !peer_hup && input.len()<ROOM {input.push_back(4);eof=false;}
            if !peer_open && output.is_empty() {return Ok(0)}
            let events=(if peer_open && output.len()<ROOM {libc::POLLIN}else{0}) | (if !peer_hup && !input.is_empty() {libc::POLLOUT}else{0});
            let mut fds=[
                libc::pollfd{fd:if events!=0 {self.peer}else{-1},events,revents:0},
                libc::pollfd{fd:if typing && input.len()<ROOM {0}else{-1},events:libc::POLLIN,revents:0},
                libc::pollfd{fd:if output.is_empty(){-1}else{1},events:libc::POLLOUT,revents:0},
                libc::pollfd{fd:self.signals,events:libc::POLLIN,revents:0},
            ];
            let polled=unsafe{libc::poll(fds.as_mut_ptr(),fds.len() as libc::nfds_t,-1)};
            if polled<0 {let e=io::Error::last_os_error();if e.kind()==io::ErrorKind::Interrupted {continue}return Err(e)}
            if fds[3].revents!=0 {if let Some(status)=self.signal()? {return Ok(status)}}
            if fds[0].revents & libc::POLLHUP!=0 {peer_hup=true;typing=false;eof=false;input.clear();}
            if fds[0].revents & (libc::POLLIN|libc::POLLHUP|libc::POLLERR)!=0 && output.len()<ROOM {
                match read_into(self.peer,&mut output) {
                    Ok(false)=>{peer_open=false;typing=false;input.clear();},
                    Err(e) if e.raw_os_error()==Some(libc::EIO)=>{peer_open=false;typing=false;input.clear();},
                    Err(e)=>return Err(e),_=>{}
                }
            }
            if peer_open && !peer_hup && typing && fds[1].revents!=0 {if !read_into(0,&mut input)? {typing=false;eof=self.original.is_none();}}
            if peer_open && !peer_hup && fds[0].revents & libc::POLLOUT!=0 {write_from(self.peer,&mut input)?;}
            if fds[2].revents!=0 {write_from(1,&mut output)?;}
        }
    }
}
fn read_into(fd:RawFd,queue:&mut VecDeque<u8>)->io::Result<bool> {
    let mut bytes=[0;ROOM];let room=ROOM-queue.len();
    let count=unsafe{libc::read(fd,bytes.as_mut_ptr().cast(),room)};
    if count<0 {let e=io::Error::last_os_error();if matches!(e.kind(),io::ErrorKind::WouldBlock|io::ErrorKind::Interrupted) {return Ok(true)}return Err(e)}
    queue.extend(&bytes[..count as usize]);Ok(count!=0)
}
fn write_from(fd:RawFd,queue:&mut VecDeque<u8>)->io::Result<()> {
    let (first,second)=queue.as_slices();let bytes=if first.is_empty(){second}else{first};
    if bytes.is_empty() {return Ok(())}
    let count=unsafe{libc::write(fd,bytes.as_ptr().cast(),bytes.len())};
    if count<0 {let e=io::Error::last_os_error();if matches!(e.kind(),io::ErrorKind::WouldBlock|io::ErrorKind::Interrupted) {return Ok(())}return Err(e)}
    if count==0 {return Err(io::Error::new(io::ErrorKind::WriteZero,"terminal write"))}
    queue.drain(..count as usize);Ok(())
}
fn main()->ExitCode {
    let args:Vec<_>=std::env::args().collect();
    let fd=if args.len()==3 && args[1]=="attach" {args[2].parse::<i32>().ok().filter(|n|*n>=3)}else{None};
    let result=fd.ok_or_else(||io::Error::other("usage: prompt attach FD")).and_then(|fd|Terminal::attach(fd)?.run());
    match result {Ok(status)=>ExitCode::from(status),Err(e)=>{eprintln!("prompt: {e}");ExitCode::FAILURE}}
}
