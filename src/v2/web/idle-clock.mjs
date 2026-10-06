// Transport one C-selected clock deadline. This owns no guest timer, IRQ,
// device state or Linux meaning; late host callbacks report measured time.
export async function waitForClock({deadlineNanoseconds,virtualNanoseconds,signal}={}){
  const max=(1n<<64n)-1n;
  if(typeof deadlineNanoseconds!=='bigint' || typeof virtualNanoseconds!=='bigint'
      || virtualNanoseconds<0n || deadlineNanoseconds>max || deadlineNanoseconds<=virtualNanoseconds)
    throw new RangeError('strict future u64 clock deadline');
  if(signal!=null && (typeof signal.addEventListener!=='function' || typeof signal.removeEventListener!=='function'
      || typeof signal.aborted!=='boolean'))throw new TypeError('clock cancellation signal');
  const cancelled=()=>signal?.reason??new DOMException('Clock wait cancelled','AbortError');
  if(signal?.aborted)throw cancelled();
  const wanted=deadlineNanoseconds-virtualNanoseconds,started=performance.now();
  for(;;){
    if(signal?.aborted)throw cancelled();
    const delta=performance.now()-started;
    if(!Number.isFinite(delta) || delta<0)throw new Error('monotonic clock observation');
    const elapsedNanoseconds=BigInt(Math.floor(delta*1000000));
    if(elapsedNanoseconds>max-virtualNanoseconds)throw new RangeError('clock timestamp exhausted');
    if(elapsedNanoseconds>=wanted)return {elapsedNanoseconds};
    // Browsers/Node use a signed 32-bit millisecond timer. Long waits remain
    // cancellable; early/precision-clamped callbacks cannot fabricate time.
    const delay=Math.min(2147483647,Math.max(1,Math.ceil(Number(wanted-elapsedNanoseconds)/1000000)));
    await new Promise((resolve,reject)=>{
      let settled=false,timer;
      const finish=(aborted=false,error)=>{
        if(settled)return;settled=true;clearTimeout(timer);
        signal?.removeEventListener('abort',abort);
        if(aborted)reject(error);else resolve();
      };
      const abort=()=>finish(true,cancelled());
      timer=setTimeout(()=>finish(),delay);
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();
    });
  }
}
