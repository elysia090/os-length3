// Diagnostic output witness only; it does not interpret guest instructions.
export class CompilerOutput {
  #memory;
  #minimumBytes;
  constructor(bytes,output,capacity,report,memory) {
    if (!(bytes instanceof Uint8Array) || ![output,capacity,report].every(Number.isSafeInteger)
        || output<0 || capacity<1 || capacity>65536 || report<output+capacity
        || report+80>bytes.length || (report&7)
        || (typeof SharedArrayBuffer==='function' && bytes.buffer instanceof SharedArrayBuffer))
      throw new RangeError('private disjoint bounded compiler output');
    if (memory!==undefined && (!(memory instanceof WebAssembly.Memory) || memory.buffer!==bytes.buffer
        || bytes.byteOffset!==0 || bytes.byteLength!==memory.buffer.byteLength))
      throw new RangeError('compiler output memory identity');
    this.#memory=memory; this.#minimumBytes=bytes.byteLength;
    this.bytes=bytes; this.output=output; this.capacity=capacity; this.report=report;
    this.view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    this.initialPoisonBytes=capacity+80; this.clearedModuleBytes=0; this.clearedReportBytes=0;
    this.emissions=0; this.refusalComparisons=0; this.dirty=0; this.failed=false;
    bytes.fill(0xa5,output,output+capacity); bytes.fill(0xa5,report,report+80);
  }
  refresh() {
    if (this.failed) throw new Error('failed compiler output witness');
    if (!this.#memory) throw new Error('compiler output has no grow owner');
    const buffer=this.#memory.buffer;
    if (buffer===this.bytes.buffer) return;
    if (buffer.byteLength<this.#minimumBytes
        || (typeof SharedArrayBuffer==='function' && buffer instanceof SharedArrayBuffer)) {
      this.failed=true; throw new RangeError('private monotone compiler output memory');
    }
    // Memory.grow preserves old bytes. Neither re-poison nor recreate this
    // witness: retained dirty prefixes and illegal tail writes remain visible.
    this.bytes=new Uint8Array(buffer); this.view=new DataView(buffer);
    this.#minimumBytes=buffer.byteLength;
  }
  emit(compile) {
    if (this.failed) throw new Error('failed compiler output witness');
    try {
      if (this.#memory) this.refresh();
      // Outside the preceding declared prefix, the initial poison still
      // resides. Clear only that prefix and the fixed successful report.
      // Refusals still compare the ENTIRE output/report below; an illegal
      // tail write is retained and detected, not erased on the next attempt.
      if (this.dirty) {
        this.bytes.fill(0xa5,this.output,this.output+this.dirty);
        this.bytes.fill(0xa5,this.report,this.report+80);
        this.clearedModuleBytes+=this.dirty; this.clearedReportBytes+=80;
      }
      this.dirty=0; ++this.emissions;
      const status=compile();
      if (this.#memory) this.refresh();
      if (!Number.isSafeInteger(status)) throw new TypeError('synchronous compiler status');
      if (status) {
        ++this.refusalComparisons;
        if (!this.bytes.subarray(this.output,this.output+this.capacity).every(byte=>byte===0xa5)
            || !this.bytes.subarray(this.report,this.report+80).every(byte=>byte===0xa5))
          throw new Error('compiler refusal must not publish output or report');
      } else {
        const length=this.view.getBigUint64(this.report+40,true);
        if (length<1n || length>BigInt(this.capacity)) throw new RangeError('bounded compiler result');
        this.dirty=Number(length);
      }
      return status;
    } catch (error) { this.failed=true; throw error; }
  }
  stats() {
    return {initialPoisonBytes:this.initialPoisonBytes,clearedModuleBytes:this.clearedModuleBytes,
      clearedReportBytes:this.clearedReportBytes,emissions:this.emissions,refusalComparisons:this.refusalComparisons};
  }
}
