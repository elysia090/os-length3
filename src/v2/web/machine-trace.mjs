// Bounded observation only. Words never enter guest state or dispatch.
export class CutTrace {
  constructor() {
    this.words=new BigUint64Array(16*8);
    // A 64-cut cohort can retire 65,536 source instructions; 16 bits wraps.
    this.instructions=new Uint32Array(16);
    this.head=0;this.count=0;
  }
  append(entry,instructions,next,result,view,state) {
    if(!Number.isInteger(instructions)||instructions<0||instructions>0xffffffff)
      throw new RangeError('bounded trace retirement count');
    const at=this.head*8;
    this.words[at]=entry;this.words[at+1]=next;this.words[at+2]=result;
    this.words[at+3]=view.getBigUint64(state,true);
    this.words[at+4]=view.getBigUint64(state+8,true);
    this.words[at+5]=view.getBigUint64(state+16,true);
    this.words[at+6]=view.getBigUint64(state+56,true);
    this.words[at+7]=view.getBigUint64(state+392,true);
    this.instructions[this.head]=instructions;
    this.head=(this.head+1)&15;this.count=Math.min(16,this.count+1);
  }
  read(limit=16) {
    if(!Number.isInteger(limit)||limit<0||limit>16)throw new RangeError('bounded trace observation');
    const count=Math.min(limit,this.count),first=(this.head-count+16)&15;
    return Array.from({length:count},(_,rank)=>{
      const slot=(first+rank)&15,at=slot*8,hex=index=>`0x${this.words[at+index].toString(16)}`;
      return {entry:hex(0),instructions:this.instructions[slot],next:hex(1),result:String(this.words[at+2]),
        rax:hex(3),rcx:hex(4),rdx:hex(5),rdi:hex(6),flags:hex(7)};
    });
  }
}
