#include "cut-internal.h"
void cut_lower_vector_lane(cut_lowering *c,const pl_x86_instruction *i,const pl_x86_vector_lane *p)
{
    cut_sse_guard(c);pl_u32 offset=(pl_u32)offsetof(machine_state,xmm)+(pl_u32)p->vector*16u+(pl_u32)p->lane*p->bytes;
    if(p->insert){if(p->memory)cut_const(c,0u);else{cut_read_operand(c,&i->operands[1],p->bytes*8u);cut_mask(c,p->bytes*8u);}}
    else{cut_get(c,0u);cut_op(c,p->bytes==1u?0x31u:p->bytes==2u?0x33u:p->bytes==4u?0x35u:0x29u);
        wasm_writer_uleb(c->writer,p->bytes==1u?0u:p->bytes==2u?1u:p->bytes==4u?2u:3u);wasm_writer_uleb(c->writer,offset);}
    cut_set(c,CUT_VALUE);
    if(p->memory){const pl_x86_memory *m=&i->operands[p->insert?1u:0u].value.memory;
        cut_effective_address(c,i,m);cut_set(c,CUT_ADDRESS);c->report.memory_bytes=p->bytes;c->report.memory_access=(p->insert?MACHINE_MEMORY_READ:MACHINE_MEMORY_WRITE)|cut_memory_role(m);
        cut_access(c);if(p->insert){cut_access_value(c);cut_set(c,CUT_VALUE);}}
    if(p->insert){cut_get(c,0u);cut_get(c,CUT_VALUE);cut_op(c,p->bytes==1u?0x3cu:p->bytes==2u?0x3du:p->bytes==4u?0x3eu:0x37u);
        wasm_writer_uleb(c->writer,p->bytes==1u?0u:p->bytes==2u?1u:p->bytes==4u?2u:3u);wasm_writer_uleb(c->writer,offset);}
    else if(!p->memory)cut_write_register(c,&i->operands[0].value.reg);
}
