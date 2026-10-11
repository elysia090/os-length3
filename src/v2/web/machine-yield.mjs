// A resolved Promise yields only to microtasks, not Worker IO message tasks.
// Give opaque network/input/close transports a bounded scheduling opportunity
// at the caller's already completed C cut boundary. This changes no guest
// retirement, clock, device state, quantum, permission or timeout.
export class MachineYield {
  constructor({budgetMs=8,now=()=>performance.now(),pause}={}) {
    if(!Number.isFinite(budgetMs)||budgetMs<=0||typeof now!=='function'||pause!==undefined&&typeof pause!=='function')throw new TypeError('bounded task opportunity');
    this.budgetMs=budgetMs;this.now=now;this.last=now();this.count=0;this.closed=false;this.pending=null;
    if(pause)this.pause=pause;
    else{
      this.pause=()=>new Promise(resolve=>{
        // Startup refusal creates no live task port. One channel is owned
        // only when the fully initialized machine first yields.
        if(!this.channel){this.channel=new MessageChannel();
          this.channel.port1.onmessage=()=>{const waiting=this.pending;this.pending=null;waiting?.();};}
        this.pending=resolve;this.channel.port2.postMessage(0);
      });
    }
  }
  due(){return this.now()-this.last>=this.budgetMs;}
  async yield(){if(this.closed||this.pending)throw new Error('serialized live task owner');await this.pause();this.last=this.now();++this.count;}
  close(){if(this.closed)return;this.closed=true;this.channel?.port1.close();this.channel?.port2.close();
    const waiting=this.pending;this.pending=null;waiting?.();}
}
