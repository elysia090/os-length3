#include "cut-internal.h"
#include <machine/io.h>
enum {SI_CURSOR=26,SI_VALUE,SI_STRIDE,SI_BUDGET};
static void checkpoint(cut_lowering *c,pl_u32 action,pl_u32 cursor,pl_u32 value)
{
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_i32_const(c,action);cut_const(c,cursor);
    if(value)cut_get(c,SI_VALUE);else cut_const(c,0u);
    cut_call(c,WASM_IMPORT_CHECKPOINT);cut_access_status(c);
}
static void io(cut_lowering *c,const pl_x86_string_io *law,pl_u32 mode)
{
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_get(c,3u);cut_const(c,65535u);cut_op(c,0x83u);cut_op(c,0xa7u);
    cut_i32_const(c,law->bytes|(law->write?MACHINE_IO_WRITE:0u)|mode);
    if(law->write&&mode!=MACHINE_IO_CHECK)cut_get(c,SI_VALUE);else cut_const(c,0u);
    cut_call(c,WASM_IMPORT_IO);cut_access_status(c);
}
void cut_lower_string_io(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_string_io law;if(!pl_x86_string_io_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    const pl_x86_operand *memory=pl_x86_string_io_memory(i);
    const pl_x86_operand dx={.kind=PL_X86_OPERAND_REGISTER,.bits=64u,.value.reg={PL_X86_REGISTER_GPR,2u,64u,0u}};
    const pl_x86_operand index={.kind=PL_X86_OPERAND_REGISTER,.bits=64u,.value.reg={PL_X86_REGISTER_GPR,law.index,64u,0u}};
    cut_read_operand(c,&dx,64u);cut_op(c,0x1au);cut_read_operand(c,&index,64u);cut_op(c,0x1au);
    if(law.repeated){const pl_x86_operand count={.kind=PL_X86_OPERAND_REGISTER,.bits=64u,.value.reg={PL_X86_REGISTER_GPR,1u,64u,0u}};
        cut_read_operand(c,&count,64u);cut_op(c,0x1au);}
    c->report.written_registers|=(1u<<law.index)|(law.repeated?2u:0u);
    checkpoint(c,MACHINE_CHECKPOINT_GET,0u,0u);
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_op(c,0x29u);wasm_writer_uleb(c->writer,3u);
    wasm_writer_uleb(c->writer,offsetof(machine_memory_checkpoint_port,cursor));cut_set(c,SI_CURSOR);
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_op(c,0x29u);wasm_writer_uleb(c->writer,3u);
    wasm_writer_uleb(c->writer,offsetof(machine_memory_checkpoint_port,frontier));cut_set(c,SI_VALUE);
    cut_get(c,SI_CURSOR);cut_op(c,0x50u);cut_op(c,0x04u);cut_op(c,0x40u);
    // I/O permission is observed before even a zero-count REP or memory fault.
    io(c,&law,MACHINE_IO_CHECK);checkpoint(c,MACHINE_CHECKPOINT_SET,1u,0u);cut_const(c,1u);cut_set(c,SI_CURSOR);cut_op(c,0x0bu);
    cut_get(c,CUT_FLAGS);cut_const(c,0x400u);cut_op(c,0x83u);cut_op(c,0x50u);cut_op(c,0x04u);cut_op(c,0x40u);
    cut_const(c,law.bytes);cut_set(c,SI_STRIDE);cut_op(c,0x05u);cut_const(c,0ull-law.bytes);cut_set(c,SI_STRIDE);cut_op(c,0x0bu);
    cut_const(c,MACHINE_REPEAT_MAX_ELEMENTS);cut_set(c,SI_BUDGET);
    cut_op(c,0x02u);cut_op(c,0x40u);cut_op(c,0x03u);cut_op(c,0x40u);
    if(law.repeated){cut_get(c,2u);cut_mask(c,law.address_bits);cut_op(c,0x50u);cut_op(c,0x0du);wasm_writer_uleb(c->writer,1u);}
    cut_get(c,SI_CURSOR);cut_const(c,1u);cut_op(c,0x51u);cut_op(c,0x04u);cut_op(c,0x40u);
    if(law.write){cut_effective_address(c,i,&memory->value.memory);cut_set(c,CUT_ADDRESS);
        c->report.memory_bytes=law.bytes;c->report.memory_access=MACHINE_MEMORY_READ|cut_memory_role(&memory->value.memory);
        cut_const(c,0u);cut_set(c,CUT_VALUE);cut_access(c);cut_access_value(c);
    }else{io(c,&law,MACHINE_IO_CHECKED);cut_access_value(c);}
    cut_set(c,SI_VALUE);checkpoint(c,MACHINE_CHECKPOINT_SET,2u,1u);cut_const(c,2u);cut_set(c,SI_CURSOR);cut_op(c,0x0bu);
    if(law.write)io(c,&law,MACHINE_IO_CHECKED);
    else{cut_effective_address(c,i,&memory->value.memory);cut_set(c,CUT_ADDRESS);cut_get(c,SI_VALUE);cut_set(c,CUT_VALUE);
        c->report.memory_bytes=law.bytes;c->report.memory_access=MACHINE_MEMORY_WRITE;cut_access(c);}
    cut_get(c,law.index+1u);cut_get(c,SI_STRIDE);cut_op(c,0x7cu);cut_mask(c,law.address_bits);cut_set(c,law.index+1u);
    cut_store(c,offsetof(machine_state,registers)+law.index*8u,law.index+1u);
    if(law.repeated){cut_get(c,2u);cut_const(c,1u);cut_op(c,0x7du);cut_mask(c,law.address_bits);cut_set(c,2u);
        cut_store(c,offsetof(machine_state,registers)+8u,2u);}
    checkpoint(c,MACHINE_CHECKPOINT_SET,1u,0u);cut_const(c,1u);cut_set(c,SI_CURSOR);
    if(law.repeated){cut_get(c,2u);cut_mask(c,law.address_bits);cut_op(c,0x50u);cut_op(c,0x0du);wasm_writer_uleb(c->writer,1u);
        cut_get(c,SI_BUDGET);cut_const(c,1u);cut_op(c,0x7du);cut_set(c,SI_BUDGET);cut_get(c,SI_BUDGET);cut_op(c,0x50u);
        cut_op(c,0x04u);cut_op(c,0x40u);cut_const(c,machine_result_make(MACHINE_RESULT_BARRIER,MACHINE_BARRIER_QUANTUM));cut_op(c,0x0fu);cut_op(c,0x0bu);
        cut_op(c,0x0cu);wasm_writer_uleb(c->writer,0u);
    }else{cut_op(c,0x0cu);wasm_writer_uleb(c->writer,1u);}
    cut_op(c,0x0bu);cut_op(c,0x0bu);checkpoint(c,MACHINE_CHECKPOINT_CLEAR,0u,0u);
    c->report.memory_access=law.write?MACHINE_MEMORY_READ|cut_memory_role(&memory->value.memory):MACHINE_MEMORY_WRITE;
}
