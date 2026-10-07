#include "cut-internal.h"

static void parameter(cut_lowering *cut,pl_u32 rank)
{cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,rank);}
static void coordinate(cut_lowering *cut)
{
    parameter(cut,2u);cut_op(cut,0x23u);wasm_writer_uleb(cut->writer,0u);cut_op(cut,0x7du);
}
static void tree(cut_lowering *cut,const wasm_cut_options *cuts,const cut_body_extent *bodies,
    const pl_u16 *classes,pl_u32 begin,pl_u32 end,pl_u32 imports)
{
    if(end-begin==1u){
        coordinate(cut);cut_const(cut,cuts[begin].entry);cut_op(cut,0x51u);
        cut_op(cut,0x04u);cut_op(cut,0x7eu); /* if (result i64) */
        parameter(cut,0u);parameter(cut,1u);parameter(cut,2u);cut_i32_const(cut,bodies[begin].binding);
        cut_op(cut,0x10u);wasm_writer_uleb(cut->writer,imports+classes[begin]);
        cut_op(cut,0x05u);cut_const(cut,machine_result_make(MACHINE_RESULT_ENTRY_MAP,0u));cut_op(cut,0x0bu);
        return;
    }
    pl_u32 middle=begin+(end-begin)/2u;
    coordinate(cut);cut_const(cut,cuts[middle].entry);cut_op(cut,0x54u); /* i64.lt_u */
    cut_op(cut,0x04u);cut_op(cut,0x7eu);
    tree(cut,cuts,bodies,classes,begin,middle,imports);cut_op(cut,0x05u);
    tree(cut,cuts,bodies,classes,middle,end,imports);cut_op(cut,0x0bu);
}
void cut_emit_dispatch(wasm_writer *writer,const wasm_cut_options *cuts,
    const cut_body_extent *bodies,const pl_u16 *classes,pl_u32 count,pl_u32 imports)
{
    cut_lowering cut={.writer=writer};wasm_writer_uleb(writer,0u); /* no locals */
    tree(&cut,cuts,bodies,classes,0u,count,imports);cut_op(&cut,0x0bu);
}
