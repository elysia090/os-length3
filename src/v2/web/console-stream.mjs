// Bounded UART byte transport. A prompt or ANSI query need not end in LF.
// Flush at the next host task, not every byte or a guest-instruction milestone.
export class ConsoleStream {
  constructor(emit,{schedule=callback=>setTimeout(callback,0),cancel=timer=>clearTimeout(timer)}={}) {
    this.emit=emit;this.schedule=schedule;this.cancel=cancel;
    this.bytes=new Uint8Array(2048);this.count=0;this.timer=null;
  }
  write(bytes) {
    for(const byte of bytes) {
      this.bytes[this.count++]=byte;
      if(byte===10||this.count===this.bytes.length)this.flush();
    }
    if(this.count&&this.timer===null)
      this.timer=this.schedule(()=>{this.timer=null;this.flush();});
  }
  flush() {
    if(this.timer!==null){this.cancel(this.timer);this.timer=null;}
    if(!this.count)return;
    const count=this.count;this.count=0;
    // The consumer must synchronously copy/encode this borrowed fragment.
    this.emit(this.bytes.subarray(0,count));
  }
}
