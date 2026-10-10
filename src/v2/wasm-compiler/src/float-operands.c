/* One exact payload frontier for scalar and packed floating operations. */
#include "cut-internal.h"
void cut_sse_raise_wave(cut_lowering *c,pl_u32 raised)
{
    // Any unmasked precomputation exception stops the whole packed wave
    // before postcomputation flags. Earlier sticky flags are not new events.
    cut_get(c,raised);cut_get(c,CUT_LEFT);cut_const(c,7u);cut_op(c,0x88u);cut_const(c,~0ull);cut_op(c,0x85u);cut_op(c,0x83u);
    cut_const(c,7u);cut_op(c,0x83u);cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0x04u);cut_op(c,0x40u);
    cut_get(c,raised);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,raised);cut_op(c,0x0bu);
    cut_get(c,raised);cut_set(c,CUT_STATUS);cut_sse_raise(c,0u);
}
void cut_capture_float_operands(cut_lowering *c,const pl_x86_instruction *i,pl_u32 bytes,pl_u32 lanes,
    pl_u32 source,pl_u32 target,pl_u32 source_memory,pl_u32 first,pl_u32 second)
{
    if(source_memory){const pl_x86_memory *m=&i->operands[1].value.memory;
        cut_effective_address(c,i,m);cut_set(c,CUT_ADDRESS);c->report.memory_access=MACHINE_MEMORY_READ|cut_memory_role(m);
        if(bytes*lanes<=8u){cut_const(c,0u);cut_set(c,CUT_VALUE);cut_access(c);cut_access_value(c);cut_mask(c,bytes*lanes*8u);cut_set(c,second);
            if(lanes==2u){cut_get(c,second);cut_const(c,32u);cut_op(c,0x88u);cut_set(c,second+1u);cut_get(c,second);cut_mask(c,32u);cut_set(c,second);}}
        else{cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_get(c,CUT_ADDRESS);cut_i32_const(c,16u);
            cut_i32_const(c,c->report.memory_access|MACHINE_MEMORY_ALIGNED16);cut_call(c,WASM_IMPORT_READ_PAIR);cut_access_status(c);
            cut_access_value(c);cut_set(c,second);cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_op(c,0x29u);wasm_writer_uleb(c->writer,3u);
            wasm_writer_uleb(c->writer,offsetof(machine_memory_pair_port,high));cut_set(c,second+1u);
            if(bytes==4u){cut_get(c,second+1u);cut_const(c,32u);cut_op(c,0x88u);cut_set(c,second+3u);cut_get(c,second+1u);cut_mask(c,32u);cut_set(c,second+2u);
                cut_get(c,second);cut_const(c,32u);cut_op(c,0x88u);cut_set(c,second+1u);cut_get(c,second);cut_mask(c,32u);cut_set(c,second);}
        }
    }
    for(pl_u32 lane=0u;lane<lanes;++lane){pl_u32 offset=lane*bytes;
        if(first){cut_get(c,0u);cut_op(c,bytes==4u?0x35u:0x29u);wasm_writer_uleb(c->writer,bytes==4u?2u:3u);
            wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+target*16u+offset);cut_set(c,first+lane);}
        if(!source_memory){
            if(first&&source==target)cut_get(c,first+lane);
            else{cut_get(c,0u);cut_op(c,bytes==4u?0x35u:0x29u);wasm_writer_uleb(c->writer,bytes==4u?2u:3u);
                wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+source*16u+offset);}
            cut_set(c,second+lane);
        }
    }
}
