#include "cut-internal.h"
enum { T_CW=26,T_SW,T_TAG,T_TOP,T_DST,T_SRC,T_EA,T_EB,T_SIG,T_SE,T_VALUE,T_RAISED,T_SUPPRESS,T_WRITE,T_FIRST };
static void word(cut_lowering *c,pl_u32 offset,pl_u32 local,int store)
{cut_get(c,0u);if(store)cut_get(c,local);cut_op(c,store?0x3du:0x33u);wasm_writer_uleb(c->writer,1u);
 wasm_writer_uleb(c->writer,offset);if(!store)cut_set(c,local);}
static void lane(cut_lowering *c,pl_u32 index,pl_u32 offset,pl_u32 local,pl_u32 shift,int store)
{cut_get(c,0u);cut_get(c,index);cut_const(c,shift);cut_op(c,0x86u);cut_op(c,0xa7u);cut_op(c,0x6au);
 if(store)cut_get(c,local);
 cut_op(c,shift==3u?(store?0x37u:0x29u):(store?0x3du:0x33u));
 wasm_writer_uleb(c->writer,shift);wasm_writer_uleb(c->writer,offset);if(!store)cut_set(c,local);}
static void tag(cut_lowering *c,pl_u32 index,pl_u32 local)
{cut_get(c,T_TAG);cut_get(c,index);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);cut_set(c,local);}
void cut_lower_x87_transfer(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_x87_transfer law;if(!pl_x86_x87_transfer_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    _Alignas(8) pl_u8 scratch[32768];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    if(pl_x86_x87_transfer_plan(&law,&arena,&pure)||pure.node_count>PL_X86_X87_TRANSFER_MAX_NODES){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    cut_x87_wait_guard(c,T_CW,T_SW);word(c,offsetof(machine_state,x87_tag),T_TAG,0);
    cut_get(c,T_SW);cut_const(c,11u);cut_op(c,0x88u);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,T_TOP);
    cut_get(c,T_TOP);if(law.kind==PL_X86_X87_TRANSFER_CONSTANT){cut_const(c,7u);cut_op(c,0x7cu);cut_const(c,7u);cut_op(c,0x83u);}cut_set(c,T_DST);
    cut_get(c,T_TOP);cut_const(c,law.source);cut_op(c,0x7cu);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,T_SRC);
    tag(c,T_DST,T_EA);tag(c,T_SRC,T_EB);cut_const(c,0u);cut_set(c,T_SIG);cut_const(c,0u);cut_set(c,T_SE);
    if(law.kind==PL_X86_X87_TRANSFER_CONDITIONAL&&law.source){
        // False conditions still inspect both tags, but no latent payload is
        // needed. Empty-stack output is a literal; it does not read that lane.
        cut_condition(c,law.condition);cut_get(c,T_EA);cut_const(c,3u);cut_op(c,0x52u);cut_op(c,0x71u);
        cut_get(c,T_EB);cut_const(c,3u);cut_op(c,0x52u);cut_op(c,0x71u);cut_op(c,0x04u);cut_op(c,0x40u);
        lane(c,T_SRC,offsetof(machine_state,x87_significand),T_SIG,3u,0);lane(c,T_SRC,offsetof(machine_state,x87_sign_exponent),T_SE,1u,0);cut_op(c,0x0bu);
    }else if(law.kind==PL_X86_X87_TRANSFER_NEGATE||law.kind==PL_X86_X87_TRANSFER_ABSOLUTE){
        cut_get(c,T_EA);cut_const(c,3u);cut_op(c,0x52u);cut_op(c,0x04u);cut_op(c,0x40u);
        lane(c,T_DST,offsetof(machine_state,x87_sign_exponent),T_SE,1u,0);cut_op(c,0x0bu);
    }
    const pl_u32 inputs[]={T_SIG,T_SE,T_EA,T_EB,T_CW,CUT_FLAGS},outputs[]={T_SIG,T_SE,T_VALUE,T_RAISED,T_SUPPRESS,T_WRITE};
    cut_emit_scalar_projection(c,&pure,inputs,T_FIRST,outputs,6u);
    cut_get(c,T_SW);
    // For conditional moves C1 is unchanged without a stack fault.
    if(law.kind==PL_X86_X87_TRANSFER_CONDITIONAL)cut_get(c,T_SW);
    cut_const(c,~0x200ull);cut_op(c,0x83u);
    if(law.kind==PL_X86_X87_TRANSFER_CONDITIONAL){cut_get(c,T_RAISED);cut_op(c,0x50u);cut_op(c,0x1bu);}
    cut_get(c,T_RAISED);cut_op(c,0x84u);cut_set(c,T_SW);
    cut_get(c,T_SUPPRESS);cut_op(c,0xa7u);cut_op(c,0x04u);cut_op(c,0x40u);
    cut_get(c,T_SW);cut_const(c,0x8080u);cut_op(c,0x84u);cut_set(c,T_SW);
    cut_const(c,law.opcode);cut_set(c,CUT_VALUE);word(c,offsetof(machine_state,x87_opcode),CUT_VALUE,1);cut_op(c,0x0bu);
    cut_get(c,T_WRITE);cut_op(c,0xa7u);cut_op(c,0x04u);cut_op(c,0x40u);
    if(law.kind==PL_X86_X87_TRANSFER_NEGATE||law.kind==PL_X86_X87_TRANSFER_ABSOLUTE){
        cut_get(c,T_RAISED);cut_op(c,0xa7u);cut_op(c,0x04u);cut_op(c,0x40u);
        lane(c,T_DST,offsetof(machine_state,x87_significand),T_SIG,3u,1);cut_op(c,0x0bu);
    }else lane(c,T_DST,offsetof(machine_state,x87_significand),T_SIG,3u,1);
    lane(c,T_DST,offsetof(machine_state,x87_sign_exponent),T_SE,1u,1);
    cut_get(c,T_TAG);cut_const(c,3u);cut_get(c,T_DST);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);cut_const(c,~0ull);cut_op(c,0x85u);cut_op(c,0x83u);
    cut_get(c,T_VALUE);cut_get(c,T_DST);cut_const(c,1u);cut_op(c,0x86u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,T_TAG);
    word(c,offsetof(machine_state,x87_tag),T_TAG,1);
    if(law.kind==PL_X86_X87_TRANSFER_CONSTANT){cut_get(c,T_SW);cut_const(c,~0x3800ull);cut_op(c,0x83u);
        cut_get(c,T_DST);cut_const(c,11u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,T_SW);}
    cut_op(c,0x0bu);word(c,offsetof(machine_state,x87_status),T_SW,1);
    cut_coordinate(c,i->rip);cut_set(c,CUT_VALUE);cut_store(c,offsetof(machine_state,x87_ip),CUT_VALUE);
}
