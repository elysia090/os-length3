#!/usr/bin/env python3
"""Signed paired subdivision of an already-bound, observed semantic window (NOT timing acceptance)."""
import json,sys
def split(p):
 def side(s):
  h=p[s]; z={}
  for m in h['marks']:
   assert isinstance(m['key'],str) and m['key'] not in z and isinstance(m['us'],int) and isinstance(m['err_us'],int) and m['err_us']>=0
   z[m['key']]=m
  return z,h
 a,am=side('native');b,bm=side('sods')
 if not(am['matched_contract']==bm['matched_contract']==p['matched_contract'] and am['correctness_passed'] and bm['correctness_passed']):return {'state':'HOLD: contract or outcomes differ'}
 first,cut,last=p['keys'];assert len(set((first,cut,last)))==3
 def segment(x,y):
  d=(b[y]['us']-b[x]['us'])-(a[y]['us']-a[x]['us']);assert a[y]['us']>=a[x]['us'] and b[y]['us']>=b[x]['us']
  e=sum(s[k]['err_us'] for s in [a,b] for k in (x,y));return {'native_us':a[y]['us']-a[x]['us'],'sods_us':b[y]['us']-b[x]['us'],'signed_delta_us':d,'measurement_interval_us':[d-e,d+e],'next':'subdivide' if d-e>0 else 'signed-credit' if d+e<0 else 'unresolved-or-noise'}
 if any(k not in s for s in [a,b] for k in [first,last]):return {'state':'HOLD: enclosing anchors unavailable'}
 if any(a[k].get('unique_semantic_anchor')!=b[k].get('unique_semantic_anchor') or not a[k].get('unique_semantic_anchor') for k in (first,last)):return {'state':'HOLD: enclosing semantic anchors differ'}
 whole=segment(first,last)
 if any(cut not in s for s in [a,b]) or any(a[k].get('unique_semantic_anchor')!=b[k].get('unique_semantic_anchor') or not a[k].get('unique_semantic_anchor') for k in (first,cut,last)):
  return {'state':'HOLD: halves not comparable','enclosing':whole,'unallocated_signed_us':whole['signed_delta_us']}
 l=segment(first,cut);r=segment(cut,last);assert l['signed_delta_us']+r['signed_delta_us']==whole['signed_delta_us']
 return {'state':'DIAGNOSTIC-same-ordered-anchors','enclosing':whole,'left':l,'right':r,'unallocated_signed_us':0}
if __name__=='__main__':print(json.dumps(split(json.load(open(sys.argv[1]))),indent=2))
