#include "cut-internal.h"

int cut_fxrstor_supported(const pl_x86_instruction *instruction)
{
    return cut_fxstate_supported(instruction,1);
}

static void fault_if(cut_lowering *cut,pl_u32 vector)
{
    cut_op(cut,0x04u);cut_op(cut,0x40u);
    cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,1u);
    cut_load(cut,offsetof(machine_state,rip));cut_op(cut,0x37u);
    wasm_writer_uleb(cut->writer,3u);wasm_writer_uleb(cut->writer,offsetof(machine_memory_port,fault_address));
    cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,1u);
    cut_op(cut,0x41u);wasm_writer_uleb(cut->writer,vector);cut_op(cut,0x36u);
    wasm_writer_uleb(cut->writer,2u);wasm_writer_uleb(cut->writer,offsetof(machine_memory_port,fault_vector));
    cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,1u);cut_op(cut,0x41u);wasm_writer_uleb(cut->writer,0u);
    cut_op(cut,0x36u);wasm_writer_uleb(cut->writer,2u);wasm_writer_uleb(cut->writer,offsetof(machine_memory_port,fault_error));
    cut_const(cut,machine_result_make(MACHINE_RESULT_FAULT,vector));cut_op(cut,0x0fu);cut_op(cut,0x0bu);
}

static void port_word(cut_lowering *cut,pl_u32 offset,pl_u32 local)
{
    cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,1u);
    cut_op(cut,0x35u);wasm_writer_uleb(cut->writer,2u);wasm_writer_uleb(cut->writer,offset);
    cut_set(cut,local);
}

static void input_coordinate(cut_lowering *cut,pl_u32 offset)
{
    /* Aligned 2/8-byte fields cannot straddle the page-aligned fragment cut.
     * Select a coordinate BEFORE loading, so the unused fragment is untouched. */
    cut_get(cut,CUT_ADDRESS);cut_const(cut,offset);cut_op(cut,0x7cu);
    cut_get(cut,CUT_NEXT);cut_const(cut,offset);cut_op(cut,0x7cu);
    cut_get(cut,CUT_STATUS);cut_op(cut,0x7du);
    cut_const(cut,offset);cut_get(cut,CUT_STATUS);cut_op(cut,0x54u);cut_op(cut,0x1bu);
    cut_op(cut,0xa7u);
}

static void input(cut_lowering *cut,pl_u32 offset,pl_u32 bytes)
{
    input_coordinate(cut,offset);cut_op(cut,bytes==2u?0x33u:0x29u);
    wasm_writer_uleb(cut->writer,bytes==2u?1u:3u);wasm_writer_uleb(cut->writer,0u);
}

static void store16(cut_lowering *cut,pl_u32 offset)
{
    cut_set(cut,1u);cut_get(cut,0u);cut_get(cut,1u);cut_op(cut,0x3du);
    wasm_writer_uleb(cut->writer,1u);wasm_writer_uleb(cut->writer,offset);
}

static void physical(cut_lowering *cut,pl_u32 logical)
{
    cut_get(cut,CUT_RIGHT);cut_const(cut,logical);cut_op(cut,0x7cu);
    cut_const(cut,7u);cut_op(cut,0x83u);
}

static void register_address(cut_lowering *cut,pl_u32 logical,pl_u32 shift)
{
    cut_get(cut,0u);physical(cut,logical);cut_const(cut,shift);cut_op(cut,0x86u);
    cut_op(cut,0xa7u);cut_op(cut,0x6au);
}

void cut_lower_fxrstor(cut_lowering *cut,const pl_x86_instruction *instruction)
{
    const pl_x86_memory *address=&instruction->operands[0].value.memory;
    int wide=!!(instruction->machine_argument&(1ull<<44u));
    cut_load(cut,offsetof(machine_state,cr0));cut_const(cut,12u);cut_op(cut,0x83u);
    cut_op(cut,0x50u);cut_op(cut,0x45u);fault_if(cut,7u);
    cut->report.memory_access=MACHINE_MEMORY_READ;
    if(address->segment.class_id==PL_X86_REGISTER_SEGMENT && address->segment.index==2u)
        cut->report.memory_access|=MACHINE_MEMORY_STACK;
    cut_effective_address(cut,instruction,address);cut_set(cut,CUT_ADDRESS);
    cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,1u);cut_get(cut,CUT_ADDRESS);
    cut_op(cut,0x41u);wasm_writer_uleb(cut->writer,512u);
    cut_op(cut,0x41u);wasm_writer_uleb(cut->writer,cut->report.memory_access|MACHINE_MEMORY_ALIGNED16);
    cut_op(cut,0x10u);wasm_writer_uleb(cut->writer,0u);cut_access_status(cut);
    port_word(cut,offsetof(machine_memory_extent_port,offsets),CUT_ADDRESS);
    port_word(cut,offsetof(machine_memory_extent_port,offsets)+4u,CUT_NEXT);
    port_word(cut,offsetof(machine_memory_extent_port,lengths),CUT_STATUS);
    /* The fixed DAZ profile permits bits 0..15. Ignore the image's mask field:
     * it is software information, not authority to enable reserved MXCSR bits.
     * Complete access precedes #GP; neither path publishes partial FPU state. */
    input(cut,24u,8u);cut_mask(cut,32u);cut_set(cut,1u);
    cut_get(cut,1u);cut_const(cut,0xffff0000u);cut_op(cut,0x83u);
    cut_op(cut,0x50u);cut_op(cut,0x45u);fault_if(cut,13u);
    cut_get(cut,0u);cut_get(cut,1u);cut_op(cut,0x3eu);
    wasm_writer_uleb(cut->writer,2u);wasm_writer_uleb(cut->writer,offsetof(machine_state,mxcsr));
    input(cut,0u,8u);cut_set(cut,CUT_LEFT);
    /* ES/B are derived from restored pending unmasked x87 exceptions, not
     * arbitrary image bits. No exception is delivered by the restore itself. */
    cut_get(cut,CUT_LEFT);cut_const(cut,~(0x8080ull<<16u));cut_op(cut,0x83u);
    cut_const(cut,0x8080ull<<16u);cut_const(cut,0u);
    cut_get(cut,CUT_LEFT);cut_const(cut,16u);cut_op(cut,0x88u);
    cut_get(cut,CUT_LEFT);cut_const(cut,~0ull);cut_op(cut,0x85u);cut_op(cut,0x83u);
    cut_const(cut,63u);cut_op(cut,0x83u);cut_op(cut,0x50u);cut_op(cut,0x45u);
    cut_op(cut,0x1bu);cut_op(cut,0x84u);cut_set(cut,CUT_LEFT);
    cut_get(cut,CUT_LEFT);cut_const(cut,0x1f3fu);cut_op(cut,0x83u);
    cut_const(cut,0x40u);cut_op(cut,0x84u);store16(cut,offsetof(machine_state,x87_control));
    cut_get(cut,CUT_LEFT);cut_const(cut,16u);cut_op(cut,0x88u);store16(cut,offsetof(machine_state,x87_status));
    cut_get(cut,CUT_LEFT);cut_const(cut,48u);cut_op(cut,0x88u);cut_const(cut,0x7ffu);cut_op(cut,0x83u);
    store16(cut,offsetof(machine_state,x87_opcode));
    input(cut,8u,8u);
    if(!wide)cut_mask(cut,32u);
    else { /* FIP canonicalizes the enumerated 48-bit linear address width. */
        cut_const(cut,16u);cut_op(cut,0x86u);cut_const(cut,16u);cut_op(cut,0x87u);
    }
    cut_set(cut,1u);cut_store(cut,offsetof(machine_state,x87_ip),1u);
    input(cut,16u,8u);if(!wide)cut_mask(cut,32u);cut_set(cut,1u);cut_store(cut,offsetof(machine_state,x87_dp),1u);
    cut_get(cut,CUT_LEFT);cut_const(cut,27u);cut_op(cut,0x88u);cut_const(cut,7u);cut_op(cut,0x83u);
    cut_set(cut,CUT_RIGHT);cut_const(cut,0u);cut_set(cut,CUT_VALUE);
    for(pl_u32 logical=0u;logical<8u;++logical) {
        input(cut,32u+logical*16u,8u);cut_set(cut,1u);
        input(cut,40u+logical*16u,2u);cut_set(cut,2u);
        register_address(cut,logical,3u);cut_get(cut,1u);cut_op(cut,0x37u);
        wasm_writer_uleb(cut->writer,3u);wasm_writer_uleb(cut->writer,offsetof(machine_state,x87_significand));
        register_address(cut,logical,1u);cut_get(cut,2u);cut_op(cut,0x3du);
        wasm_writer_uleb(cut->writer,1u);wasm_writer_uleb(cut->writer,offsetof(machine_state,x87_sign_exponent));
        cut_get(cut,2u);cut_const(cut,0x7fffu);cut_op(cut,0x83u);cut_set(cut,2u);
        cut_get(cut,CUT_VALUE);cut_const(cut,3u);cut_const(cut,1u);
        cut_get(cut,2u);cut_op(cut,0x50u);
        cut_get(cut,2u);cut_const(cut,0x7fffu);cut_op(cut,0x51u);cut_op(cut,0x72u);
        cut_get(cut,1u);cut_const(cut,63u);cut_op(cut,0x88u);cut_op(cut,0x50u);cut_op(cut,0x72u);
        cut_op(cut,0xadu);cut_const(cut,1u);cut_op(cut,0x86u);
        cut_get(cut,2u);cut_op(cut,0x50u);cut_get(cut,1u);cut_op(cut,0x50u);cut_op(cut,0x71u);cut_op(cut,0x1bu);
        cut_get(cut,CUT_LEFT);cut_const(cut,32u);cut_op(cut,0x88u);physical(cut,logical);
        cut_op(cut,0x88u);cut_const(cut,1u);cut_op(cut,0x83u);cut_op(cut,0x50u);cut_op(cut,0x1bu);
        physical(cut,logical);cut_const(cut,1u);cut_op(cut,0x86u);cut_op(cut,0x86u);
        cut_op(cut,0x84u);cut_set(cut,CUT_VALUE);
    }
    cut_get(cut,CUT_VALUE);store16(cut,offsetof(machine_state,x87_tag));
    for(pl_u32 rank=0u;rank<MACHINE_X86_XMM_WORDS/2u;++rank) {
        /* Full aligned XMM lanes, not thirty-two scalar payload projections.
         * A page boundary is also a lane boundary; the selected fragment is
         * loaded once directly into its final architectural vector. */
        cut_get(cut,0u);input_coordinate(cut,160u+rank*16u);
        cut_op(cut,0xfdu);wasm_writer_uleb(cut->writer,0u);
        wasm_writer_uleb(cut->writer,4u);wasm_writer_uleb(cut->writer,0u);
        cut_op(cut,0xfdu);wasm_writer_uleb(cut->writer,11u);
        wasm_writer_uleb(cut->writer,3u);wasm_writer_uleb(cut->writer,offsetof(machine_state,xmm)+rank*16u);
    }
    /* No image, gather or array rotation. Reserved/software tail is validated
     * as part of the architectural extent but never loaded into live state.
     * OSFXSR=0 restores full SIMD state in this fixed implementation as FXSAVE
     * saves it; pending x87/SIMD exceptions wait for a future FP operation. */
}
