#!/usr/bin/env python3
"""Target dispatch only, exclusive wall + exclusive single-TID CPU intervals and independent hash-verified top-frame census."""
import bisect, collections as C, hashlib, json, pathlib, sys
r=json.load(open(sys.argv[1]));tr=json.load(open(sys.argv[2]))['traceEvents'];maps={}
for name in sys.argv[3:]:
 m=json.load(open(name));assert m['sha'] not in maps;maps[m['sha']]=m
assert r['format']=='rxcc1-v1' and r['node']=='v24.22.3' and r['v8']=='13.6.233.17-node.63';profile=r['profile'];pid=r['pid'];mk={};focus=None
for t in tr:
 if t.get('pid')!=pid or not t.get('name','').startswith('count::rxcc|'):continue
 assert t['ph']=='C' and t['args']['data']==1 and 'tts' in t
 key=t['name'].split('|',1)[1];assert key not in mk;mk[key]=(t['ts'],t['tts']);focus=focus or t['tid'];assert t['tid']==focus
# Bool return from solver is not a proof of identical clock rates on other engines; units require this calibrated same-process Node build.
p0,p1=profile['startTime'],profile['endTime'];unc=2
lo=max(mk['p0l'][0]-p0,mk['p1l'][0]-p1)-unc;hi=min(mk['p0r'][0]-p0,mk['p1r'][0]-p1)+unc
assert lo<=hi,'unrelated clock domains'
def owner(d):return (d['role'],d['epoch'],d['pid'],d['proc'],d['image'],d['instance'],d['wasm'],d['elf'],d['execGeneration'],d['phase'],d['fileObject'],d['revision'])
allrows=[];dispatch=[];groups={};twindows=[];per={}
for i,d in enumerate(r['meta']):
 assert d['n']==i
 a,b=mk['b|'+str(i)],mk['e|'+str(i)];assert b[0]>=a[0] and b[1]>=a[1]
 if d['kind']=='dispatch':
  key=owner(d);g=groups.setdefault(key,len(groups));twindows.append((a[0],b[0],g));allrows.append((a,b,'dispatch',g));o=d['wasm'];assert o in maps and maps[o]['elfSha']==d['elf']
 elif d['kind']=='import':
  n=d['nm']; io=n=='syscall' and int(d['nr']) in (0,1,2,3,4,5,6,8,17,18,19,20,21,74,75,76,77,82,83,84,87,89,217,257,258,262,263,264,267,316,332)
  allrows.append((a,b,'sync-file-io' if io else 'sync-runtime-import',None))
 else:raise ValueError(d['kind'])
assert groups
jit={'wasm.CompileLazy','wasm.TopTierCompilation','wasm.BaselineCompilation'};bg=[];fg=[]
for t in tr:
 if t.get('pid')!=pid or t.get('ph')!='X':continue
 n=t['name'];cat=t['cat'].split(',');j=n in jit and 'v8.wasm' in cat
 gc=n in ('MinorGC','MajorGC') and 'v8' in cat
 engine=n in ('wasm.SyncCompile','wasm.SyncInstantiate','wasm.GrowMemory','wasm.ExecuteCompilationUnits','wasm.LogCode') and 'v8.wasm' in cat
 if not (j or gc or engine):continue
 if t['tid']!=focus:
  if j and t['dur']>0:bg.append((t['ts'],t['ts']+t['dur']))
  continue
 assert 'tdur' in t and 'tts' in t and t['tdur']>=0 and t['dur']>=0
 a=t['ts'],t['tts'];b=t['ts']+t['dur'],t['tts']+t['tdur']
 kind='engine-jit-scope' if j else 'engine-gc-scope' if gc else 'other-known-engine-scope'
 allrows.append((a,b,kind,None))
 if j:fg.append((a[0],b[0],n))
# Sweep both axes independently; don't interpolate CPU from wall. V8 nested named
# scopes union once; overlap with worker work is annotation, never an extra summand.
prior={'engine-gc-scope':0,'engine-jit-scope':1,'other-known-engine-scope':2,'sync-file-io':3,'sync-runtime-import':4}
def partition(ax):
 events=C.defaultdict(list)
 for i,(a,b,k,g) in enumerate(allrows):
  if b[ax]>a[ax]:events[a[ax]].append((1,i,k,g));events[b[ax]].append((-1,i,k,g))
 act=set(); kinds=C.Counter();out=C.defaultdict(C.Counter);prev=None
 for at,mods in sorted(events.items()):
  if prev is not None and prev<at and act:
   assert len(act)==1,'overlapping target dispatch on the same TID';g=next(iter(act))[1]
   ks=[k for k in prior if kinds[k]];label=min(ks,key=lambda k:prior[k]) if ks else 'dispatch-remainder-guest-or-unseen-engine'
   out[g][label]+=at-prev
  # update all end/start changes before assigning next half-open slice
  for sign,i,k,g in sorted(mods):
   if k=='dispatch':
    if sign<0:act.remove((i,g))
    else:act.add((i,g))
   else:kinds[k]+=sign;assert kinds[k]>=0
  prev=at
 assert not act and all(x==0 for x in kinds.values())
 for _,g in groups.items():
  expected=sum(b[ax]-a[ax] for a,b,k,h in allrows if k=='dispatch' and h==g)
  assert sum(out[g].values())==expected
 return out
wall=partition(0);cpu=partition(1)
def union(a):
 out=[]
 for s,e in sorted(a):
  if s>=e:continue
  if out and s<=out[-1][1]:out[-1][1]=max(e,out[-1][1])
  else:out.append([s,e])
 return out
def overlap(a,b):
 a=union(a);b=union(b);i=j=tot=0
 while i<len(a) and j<len(b):
  tot+=max(0,min(a[i][1],b[j][1])-max(a[i][0],b[j][0]))
  if a[i][1]<b[j][1]:i+=1
  else:j+=1
 return tot
wins=sorted(twindows);starts=[s for s,e,g in wins];assert all(wins[i][1]<=wins[i+1][0] for i in range(len(wins)-1))
nodes={x['id']:x['callFrame'] for x in profile['nodes']};counts=C.defaultdict(C.Counter);allhits=C.Counter();st=C.Counter();names={}
tables={sha:{q['start']:q for q in m['rows']} for sha,m in maps.items()};groupData={g:k for k,g in groups.items()}
# A verified selected-dispatch callback on the sampled stack is independent phase evidence.
# It may disambiguate a 1ms timeslice even when profiler bracket uncertainty is larger.
obs=r.get('observer');parents={c:n['id'] for n in profile['nodes'] for c in n.get('children',[])}
observer_valid=obs and hashlib.sha256(pathlib.Path(__file__).with_name('cc-observer.ts').read_bytes()).hexdigest()==obs['sha256'] and obs['callbackLine']>=0
def selected_stack(nid):
 if not observer_valid:return False
 while nid in parents:
  p=parents[nid];gp=parents.get(p);f=nodes[nid]
  if (gp is not None and f['scriptId']==obs['id'] and f['lineNumber']==obs['callbackLine'] and
      f['functionName']=='' and nodes[p]['functionName']=='scope' and nodes[gp]['functionName']=='dispatch' and
      nodes[p]['scriptId']==obs['id'] and nodes[gp]['scriptId']==obs['id']):return True
  nid=p
 return False
knownStack={nid:selected_stack(nid) for nid in nodes}
samples=profile['samples'];deltas=profile['timeDeltas'];assert len(deltas)==len(samples)
ts=p0
for nid,de in zip(samples,deltas):
 assert de>=0,'nonmonotonic V8 sample timestamps';ts+=de; f=nodes[nid]; s=ts+lo;e=ts+hi;j=bisect.bisect_right(starts,s)-1
 k=None if j<0 or wins[j][1]<=e else wins[j][2]
 sh=r['bindings'].get(f['scriptId'],{}).get('sha256')
 cert=None
 if sh in tables and f['lineNumber']==0:
  entry=tables[sh].get(f['columnNumber'])
  if entry and entry['name']==f['functionName']:
   ef=entry.get('elf',{});cert=f"#{entry['idx']} {entry['name']} (ELF {ef.get('symbol') or ef.get('vma') or 'helper'})"
   if cert:allhits[sh[:12]+' '+cert]+=1
 if k is None and knownStack[nid]:
  # Only one eligible execution OWNER can intersect the entire timestamp uncertainty.
  # Never pick one on URL, module hash or nearest PID when multiple candidate owners exist.
  i=max(0,bisect.bisect_left(starts,s)-1);gg=set()
  while i<len(wins) and wins[i][0]<=e:
   if wins[i][1]>=s:gg.add(wins[i][2])
   i+=1
  if len(gg)==1:k=next(iter(gg));st['in-dispatch-by-verified-stack-and-unique-epoch']+=1
 elif k is not None:st['strictly-in-dispatch-by-clock']+=1
 if k is None:st['outside-or-boundary-uncertain']+=1;continue
 if cert and sh==groupData[k][6]:counts[k][cert]+=1
 elif cert:counts[k]['other-known-guest-module-not-target']+=1
 elif sh==groupData[k][6]:counts[k]['selected-guest-module-unresolved-top-frame']+=1
 elif sh:counts[k]['other-Wasm-including-runtime']+=1
 else:counts[k]['host-or-unresolved']+=1
print(json.dumps({'kind':'diagnostic only; never a stock timer or a function-ms estimator','samples':len(samples),'sample_clock_offset_range_us':[lo,hi],'sample_window_accounting':st,'all_profile_hash_and_entry_matched_reported_leaf_samples':allhits,'rows':[{'role':k[0],'epoch':k[1],'pid':k[2],'processObject':k[3],'imageObject':k[4],'instanceObject':k[5],'wasmSha256':k[6],'elfSha256':k[7],'execGeneration':k[8],'phase':k[9],'fileObject':k[10],'fileRevision':k[11],'target_dispatch_wall_us':sum(wall[g].values()),'exclusive_wall_us':wall[g],'target_dispatch_current_thread_cpu_us':sum(cpu[g].values()),'exclusive_thread_cpu_us':cpu[g],'wall_minus_thread_cpu_us_not_diagnosed_as_blocking':sum(wall[g].values())-sum(cpu[g].values()),'background_named_jit_wall_overlap_us_not_additive':overlap([(s,e) for s,e,h in wins if h==g],bg),'kernel_proved_blocked_us':None,'per_function_elapsed_ms':None,'guest_x86_Ir':None,'translated_host_Ir':None,'all_strict_dispatch_top_samples':sum(counts[g].values()),'strict_dispatch_top_samples':counts[g]} for k,g in groups.items()]},indent=2))
