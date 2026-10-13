// Observe bootstrap output without replacing s6 readiness or stopping a console.
// A deadline is a failed observation, never proof that a daemon is unhealthy.
export class ServiceObservation {
  constructor({notify, deadlineMs=300000, schedule=(fn,ms)=>setTimeout(fn,ms), cancel=id=>clearTimeout(id)}) {
    if(typeof notify!=='function'||!Number.isSafeInteger(deadlineMs)||deadlineMs<1000||deadlineMs>900000)
      throw new TypeError('bounded service observation deadline');
    Object.assign(this,{notify,deadlineMs,schedule,cancel});
    this.tail='';this.state='not-started';this.timer=null;this.closed=false;
  }
  publish(state,reason) {
    if(this.closed||this.state===state)return;
    this.state=state;
    if(this.timer!==null){this.cancel(this.timer);this.timer=null;}
    this.notify({state,reason,deadlineMs:this.deadlineMs});
  }
  feed(text) {
    if(this.closed)return;
    this.tail=(this.tail+text).slice(-8192);
    if(this.state==='not-started'&&/(?:^|\r?\n)console-ready\r?\n/.test(this.tail)) {
      this.publish('pending','console-ready');
      this.timer=this.schedule(()=>this.publish('failed','readiness-deadline'),this.deadlineMs);
    }
    if(/(?:^|\r?\n)Service initialization failed; inspect its live state from the console\.\r?\n/.test(this.tail))
      this.publish('failed','bootstrap-exit');
    else if(/(?:^|\r?\n)boot-offline-complete\r?\n/.test(this.tail))this.publish('ready','dag-complete');
  }
  fault(){if(this.state!=='ready')this.publish('failed','machine-fault');}
  close(){this.closed=true;if(this.timer!==null)this.cancel(this.timer);this.timer=null;this.tail='';}
}
