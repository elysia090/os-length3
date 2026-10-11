import assert from 'node:assert/strict';
import {MachineDevices} from '../../src/v2/web/machine-devices.mjs';
for(const [networkFails,volumeFails]of [[false,false],[true,false],[false,true],[true,true]]){
  const events=[],networkError=new Error('network close failed'),volumeError=new Error('volume close failed');
  const network={async close(){events.push('network');await Promise.resolve();if(networkFails)throw networkError;}};
  const volume={async close(){events.push('volume');if(volumeFails)throw volumeError;}};
  const devices=new MachineDevices({volume,network});const first=devices.close(),second=devices.close();
  assert(devices.closed);const result=await Promise.allSettled([first,second]);
  assert.deepEqual(events,['network','volume']);
  for(const r of result){assert.equal(r.status,networkFails||volumeFails?'rejected':'fulfilled');
    if(r.status==='rejected')assert.equal(r.reason,volumeFails?volumeError:networkError);}
  if(networkFails||volumeFails)await assert.rejects(devices.close(),e=>e===(volumeFails?volumeError:networkError));
  else await devices.close();assert.deepEqual(events,['network','volume']);
}
const events=[],offline=new MachineDevices({volume:{async close(){events.push('volume');}}});
await offline.close();await offline.close();assert.deepEqual(events,['volume']);
console.log('Device close: five resource paths; volume cleanup after carrier failure; concurrent/repeated close preserves failure exactly once');
