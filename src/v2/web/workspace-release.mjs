// Only a closed, exclusively held workspace may switch prepared system roots.
// The Supervisor supplies the approved pin and compatibility decision. Neither
// the public cache nor this physical selector establishes publisher trust.
import {IndexedBlockStore,PersistentBlock} from './persistent-block.mjs';
import {openPreparedMachineRelease} from './prepared-release.mjs';
import {rememberWorkspaceCheckpoint,readWorkspaceCheckpoint} from './workspace-authority.mjs';
async function openVolume(storage,requireInitialized=true){
  if(storage.trusted!==true||storage.recovery!=='browser-origin'||storage.create)
    throw new Error('closed committed origin workspace required');
  const store=await IndexedBlockStore.open(storage.name,{fence:storage.fence});
  try{const volume=await PersistentBlock.open({...storage,store,onHead:head=>{storage.expectedHead=head;}});
    if(requireInitialized&&volume.fresh){await volume.close();throw new Error('Linux-initialized workspace required');}return volume;}
  catch(error){store.close();throw error;}
}
async function verifyPrepared(identity){const release=await openPreparedMachineRelease(identity);
  try{await release.verify();}finally{release.close();}}
export async function readSelectedWorkspaceRelease(storage){const volume=await openVolume(storage,false);
  try{if(volume.systemRoot===null)throw new Error('workspace has no selected release; explicit stopped selection required');
    return volume.systemRoot;}finally{await volume.close();}}
export async function selectPreparedWorkspaceRelease(storage,identity,{expectedSystemRoot,checkpointLabel}={}){
  // Requiring an exact prior identity also makes adoption of an old unbound
  // workspace explicit: its expectedSystemRoot is null, never an omitted value.
  if(expectedSystemRoot===undefined)throw new Error('explicit compatible prior system identity required');
  await verifyPrepared(identity);const volume=await openVolume(storage);
  try{
    if(volume.systemRoot!==expectedSystemRoot)throw new Error('workspace prior system identity differs');
    if(checkpointLabel)await rememberWorkspaceCheckpoint(storage,checkpointLabel);
    const before=volume.revision;await volume.selectSystemRoot(identity);
    return {beforeSequence:before,afterSequence:volume.revision,previousSystemRoot:expectedSystemRoot,systemRoot:identity};
  }finally{await volume.close();}
}
export async function restorePreparedWorkspaceRelease(storage,label){
  const saved=await readWorkspaceCheckpoint(storage,label),volume=await openVolume(storage);
  try{
    const checkpoint=await volume.inspectCheckpoint(saved);
    if(checkpoint.systemRoot===null)throw new Error('checkpoint has no selected system release; explicit legacy recovery required');
    await verifyPrepared(checkpoint.systemRoot);
    const before=volume.revision;await volume.restore(saved);
    return {beforeSequence:before,afterSequence:volume.revision,systemRoot:volume.systemRoot};
  }finally{await volume.close();}
}
