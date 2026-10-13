import assert from 'node:assert/strict';
import {MachineDevices} from '../../src/v2/web/machine-devices.mjs';
const events=[],memory=new WebAssembly.Memory({initial:2}),grants=[];
class Carrier {
  async open(g){this.g=g;events.push('open');}
  async close(){this.closed=true;events.push('close');}
  replacement(){return new Carrier();}
  take(){return null;}
}
const vm={vm_block_grant:()=>0,vm_network_grant:at=>{
  grants.push(new Uint8Array(memory.buffer,at,96).slice());return 0;},
  vm_network_revoke_grant:g=>{assert.equal(g,7n);events.push('revoke');return 0;}};
const devices=new MachineDevices({volume:{bytes:16*1048576,close:async()=>{}},network:new Carrier(),binding:[1n,2n,3n,4n]});
await devices.attach({vm,memory,scratch:8192,generation:7n});await devices.connecting;await devices.poll();
assert.equal(grants.length,1);devices.requestNetwork('disconnect');
assert.throws(()=>devices.requestNetwork('reconnect'),/pending/);
assert.equal(events.includes('revoke'),false);await devices.poll();assert.equal(devices.status().networkBound,false);
devices.requestNetwork('reconnect');await devices.poll();await devices.connecting;await devices.poll();
assert.equal(grants.length,2);
const before=new DataView(grants[0].buffer),after=new DataView(grants[1].buffer);
assert.equal(before.getBigUint64(48,true),1n);assert.equal(after.getBigUint64(48,true),2n);
for(let i=0;i<96;++i)if(i<48||i>=56)assert.equal(grants[0][i],grants[1][i],'only revision changes');
assert.equal(devices.status().reconnections,1);assert.equal(devices.status().networkBound,true);
devices.network.error=new Error('lost carrier');await devices.poll();assert.equal(devices.status().networkConnected,false);
devices.requestNetwork('reconnect');await devices.poll();await devices.connecting;await devices.poll();assert.equal(grants.length,3);
await devices.close();assert.throws(()=>devices.requestNetwork('reconnect'),/existing network/);
assert.throws(()=>new MachineDevices({volume:{}}).requestNetwork('reconnect'),/existing network/);
console.log('same-grant network reconnect: pass (safe poll, revised binding, failure recovery, no wider rights)');
