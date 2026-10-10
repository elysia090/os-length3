#include "cut-internal.h"
int cut_crc32_supported(const pl_x86_instruction *i)
{
    if(i->status!=PL_X86_DECODE_VALID||i->flow!=PL_X86_FLOW_NEXT||i->operation!=PL_X86_OPERATION_CRC32
        ||i->machine_operation!=PL_X86_MACHINE_NONE||i->visible_operand_count!=2u
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_TRAP_AFTER)))return 0;
    const pl_x86_operand *d=i->operands,*s=d+1u;
    return d->kind==PL_X86_OPERAND_REGISTER&&cut_gpr(&d->value.reg)&&!d->value.reg.flags
        &&(d->bits==32u||d->bits==64u)&&d->value.reg.bits==d->bits
        &&(s->bits==8u||s->bits==16u||s->bits==32u||s->bits==64u)
        &&(s->bits!=64u||d->bits==64u)
        &&(s->kind==PL_X86_OPERAND_MEMORY?cut_memory_address_supported(i,&s->value.memory)
            :s->kind==PL_X86_OPERAND_REGISTER&&cut_gpr(&s->value.reg)&&s->value.reg.bits==s->bits);
}
void cut_crc32_value(cut_lowering *c,const pl_x86_instruction *i)
{
    cut_set(c,26u);cut_read_operand(c,i->operands,32u);cut_set(c,25u);
    _Alignas(8) pl_u8 scratch[98304];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;
    if(pl_x86_crc32_plan(i->operands[1].bits,&arena,&plan)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    const pl_u32 input[]={25u,26u},output[]={CUT_VALUE};cut_emit_scalar_projection(c,&plan,input,32u,output,1u);
    cut_write_register(c,&i->operands[0].value.reg);
}
void cut_lower_crc32(cut_lowering *c,const pl_x86_instruction *i)
{cut_read_operand(c,i->operands+1u,i->operands[1].bits);cut_crc32_value(c,i);}
