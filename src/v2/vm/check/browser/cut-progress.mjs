// Bounded supervisor accounting, not a CPU image or instruction interpreter.
export class CutProgress {
  constructor(retired) {
    this.reset(retired);
  }
  reset(retired) {
    if(!Number.isSafeInteger(retired) || retired<0)throw new Error('invalid retired base');
    this.base=retired;this.completed=0;this.retired=0;
  }
  add(completed,retired,architecturalRetired,budget) {
    if(!Number.isInteger(budget) || budget<1 || !Number.isInteger(completed)
        || completed<0 || completed>budget || typeof retired!=='bigint'
        || retired<BigInt(completed) || retired>BigInt(completed)*1024n)
      throw new Error('invalid C retirement prefix');
    const total=this.retired+Number(retired);
    if(!Number.isSafeInteger(this.base+total) || architecturalRetired!==BigInt(this.base+total))
      throw new Error('architectural retirement disagrees with C prefix');
    this.completed+=completed;this.retired=total;
  }
}
