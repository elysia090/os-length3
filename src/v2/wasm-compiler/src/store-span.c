#include "cut-internal.h"
static int same_register(const pl_x86_register *a,const pl_x86_register *b)
{return a->class_id==b->class_id&&a->index==b->index&&a->bits==b->bits&&a->flags==b->flags;}
static int store(const pl_x86_instruction *i)
{
    return cut_memory_supported(i)&&i->operation==PL_X86_OPERATION_MOVE&&i->visible_operand_count==2u
        &&i->address_width==64u&&i->operands[0].kind==PL_X86_OPERAND_MEMORY&&i->operands[0].bits==64u
        &&i->operands[1].kind==PL_X86_OPERAND_REGISTER&&i->operands[1].bits==64u
        &&cut_gpr(&i->operands[1].value.reg)&&i->operands[0].value.memory.base.class_id==PL_X86_REGISTER_GPR
        &&!cut_memory_role(&i->operands[0].value.memory);
}
pl_u64 cut_prepare_store_span(cut_plan *p,const pl_x86_instruction *first,pl_u32 limit)
{
    if(!store(first)||(first->rip>>12u)!=((first->fallthrough-1u)>>12u))return first->fallthrough;
    const pl_x86_memory *a=&first->operands[0].value.memory;pl_u64 end=first->fallthrough;
    if(limit>16u)limit=16u;
    pl_u32 count=1u;
    while(count<limit){pl_x86_instruction i;if(pl_x86_decode_profile(&p->image,end,&i)||!store(&i)
            ||(i.rip>>12u)!=(first->rip>>12u)||(i.rip>>12u)!=((i.fallthrough-1u)>>12u))break;
        const pl_x86_memory *b=&i.operands[0].value.memory;
        if(!same_register(&first->operands[1].value.reg,&i.operands[1].value.reg)
            ||!same_register(&a->base,&b->base)||!same_register(&a->index,&b->index)||!same_register(&a->segment,&b->segment)
            ||a->scale!=b->scale||b->displacement!=a->displacement+(pl_i64)count*8)break;
        p->flag_frontier[count]=0u;++count;end=i.fallthrough;
    }
    if(count>1u){p->store_span=count;p->report.source_instructions=count;p->report.source_bytes=end-first->rip;}
    return end;
}
void cut_lower_store_span(cut_lowering *c,const cut_plan *p)
{
    pl_x86_instruction first;if(pl_x86_decode_profile(&p->image,p->report.entry,&first)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    cut_effective_address(c,&first,&first.operands[0].value.memory);cut_set(c,CUT_ADDRESS);
    cut_read_operand(c,&first.operands[1],64u);cut_set(c,CUT_LEFT);
    cut_const(c,p->store_span);cut_set(c,CUT_RIGHT);cut_const(c,p->store_span);cut_set(c,CUT_REPEAT_BUDGET);
    cut_pattern_count(c,8u,CUT_RIGHT,0);cut_pattern_access(c,8u,0);
    /* Completed memory words are the exact retired source prefix. The
     * provider may clip at page, paging or executable-source boundaries. */
    pl_u64 cursor=first.fallthrough;pl_u32 stride=0u,affine=1u;
    for(pl_u32 n=1u;n<p->store_span;++n){pl_x86_instruction i;if(pl_x86_decode_profile(&p->image,cursor,&i)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
        if(n==1u)stride=i.length;else if(stride!=i.length)affine=0u;cursor=i.fallthrough;}
    if(affine){cut_get(c,CUT_NEXT);cut_const(c,1u);cut_op(c,0x7du);cut_const(c,stride);cut_op(c,0x7eu);cut_const(c,first.length);cut_op(c,0x7cu);cut_set(c,CUT_ADDRESS);}
    else{cursor=p->report.entry;pl_u32 bytes=0u;cut_const(c,0u);cut_set(c,CUT_ADDRESS);
        for(pl_u32 n=0u;n<p->store_span;++n){pl_x86_instruction i;if(pl_x86_decode_profile(&p->image,cursor,&i)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
            bytes+=i.length;cursor=i.fallthrough;cut_const(c,bytes);cut_get(c,CUT_ADDRESS);cut_get(c,CUT_NEXT);cut_const(c,n+1u);cut_op(c,0x51u);cut_op(c,0x1bu);cut_set(c,CUT_ADDRESS);}}
    cut_coordinate(c,p->report.entry);cut_get(c,CUT_ADDRESS);cut_op(c,0x7cu);cut_set(c,CUT_ADDRESS);
    cut_store(c,offsetof(machine_state,rip),CUT_ADDRESS);
    cut_get(c,CUT_FLAGS);cut_const(c,~0x10000ull);cut_op(c,0x83u);cut_set(c,CUT_FLAGS);cut_store(c,offsetof(machine_state,rflags),CUT_FLAGS);
    cut_load(c,offsetof(machine_state,retired));cut_get(c,CUT_NEXT);cut_op(c,0x7cu);cut_set(c,CUT_VALUE);cut_store(c,offsetof(machine_state,retired),CUT_VALUE);
    cut_const(c,MACHINE_RESULT_RESOLVE_RIP);cut_op(c,0x0fu);
}
