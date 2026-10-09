#include "cut-internal.h"
/* Construction traversal of an already normalized pure SSA, not a VM opcode
 * evaluator. CMP contributes only its proven live CF/ZF projections here. */
static int operand_valid(const pl_plan *p,pl_operand a,pl_u32 before)
{
    if(a.kind==PL_OPERAND_CONST)return 1;
    if(a.kind==PL_OPERAND_LOCAL)return a.value<p->local_count;
    pl_u64 n=a.kind==PL_OPERAND_PROJECTION?a.value>>8u:a.value;
    if(!n||n>before)return 0;
    pl_u32 op=p->nodes[n-1u].opcode;
    if(a.kind==PL_OPERAND_NODE)return op!=PL_OPCODE_X86_COMPARE&&op!=PL_OPCODE_X86_BIT_SUMMARY&&op!=PL_OPCODE_X86_DIVIDE;
    return a.kind==PL_OPERAND_PROJECTION&&((op==PL_OPCODE_X86_COMPARE&&((a.value&255u)==2u||(a.value&255u)==4u))
        ||(op==PL_OPCODE_X86_BIT_SUMMARY&&(a.value&255u)==16u)||(op==PL_OPCODE_X86_DIVIDE&&(a.value&255u)==0u));
}
static void operand_emit(cut_lowering *c,pl_operand a,const pl_u32 *input,pl_u32 first,const pl_u8 *projections)
{
    if(a.kind==PL_OPERAND_CONST){cut_const(c,a.value);return;}
    if(a.kind==PL_OPERAND_LOCAL){cut_get(c,input[a.value]);return;}
    pl_u32 n=(pl_u32)(a.kind==PL_OPERAND_PROJECTION?a.value>>8u:a.value);
    cut_get(c,first+n-1u);
    if(a.kind==PL_OPERAND_PROJECTION&&(projections[n]==1u||projections[n]==2u))return;
    if(a.kind==PL_OPERAND_PROJECTION&&(a.value&255u)!=16u&&(a.value&255u)!=0u){if((a.value&255u)==4u){cut_const(c,6u);cut_op(c,0x88u);}
        cut_const(c,1u);cut_op(c,0x83u);}
}
static void mark_projection(const pl_plan *p,pl_operand a,pl_u8 *projections)
{
    if(a.kind==PL_OPERAND_PROJECTION&&p->nodes[(a.value>>8u)-1u].opcode==PL_OPCODE_X86_COMPARE)
        projections[a.value>>8u]|=(pl_u8)((a.value&255u)==2u?1u:2u);
}
void cut_emit_scalar_projection(cut_lowering *c,const pl_plan *p,const pl_u32 *input,pl_u32 first,const pl_u32 *output,pl_u32 count)
{
    if(!p||!input||!output||!count||count>p->local_count||p->node_count>PL_X86_X87_ARITHMETIC_MAX_NODES
        ||(p->local_count!=5u&&p->local_count!=6u)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    pl_u8 projections[PL_X86_X87_ARITHMETIC_MAX_NODES+1u]={0};
    for(pl_u32 n=0u;n<p->node_count;++n){const pl_node *node=p->nodes+n;
        if(node->argument_at>p->argument_count||node->argument_count>p->argument_count-node->argument_at)goto bad;
        const pl_operand *args=p->arguments+node->argument_at;
        pl_u32 arity=(node->opcode==PL_OPCODE_X86_COMPARE||node->opcode==PL_OPCODE_X86_BIT_SUMMARY||node->opcode==PL_OPCODE_X86_DIVIDE)?4u:node->opcode==PL_OPCODE_LANE64_SELECT?3u:2u;
        if(node->argument_count!=arity)goto bad;
        if(node->opcode!=86u&&node->opcode!=87u&&node->opcode!=88u&&node->opcode!=89u&&node->opcode!=96u
            &&node->opcode!=PL_OPCODE_LANE64_SHL&&node->opcode!=PL_OPCODE_LANE64_SHR&&node->opcode!=PL_OPCODE_LANE64_SAR
            &&node->opcode!=PL_OPCODE_LANE64_SELECT&&node->opcode!=PL_OPCODE_X86_COMPARE&&node->opcode!=PL_OPCODE_X86_BIT_SUMMARY
            &&node->opcode!=PL_OPCODE_MULR&&node->opcode!=PL_OPCODE_X86_DIVIDE)goto bad;
        if(node->opcode==PL_OPCODE_X86_DIVIDE&&(args[0].kind!=PL_OPERAND_CONST||args[0].value
            ||args[3].kind!=PL_OPERAND_CONST||args[3].value!=64u))goto bad;
        if(node->opcode==PL_OPCODE_X86_COMPARE&&(args[0].kind!=PL_OPERAND_CONST||args[0].value
            ||args[3].kind!=PL_OPERAND_CONST||args[3].value!=(64u|(3u<<8u))))goto bad;
        if(node->opcode==PL_OPCODE_X86_BIT_SUMMARY&&(args[0].kind!=PL_OPERAND_CONST||args[0].value
            ||args[2].kind!=PL_OPERAND_CONST||args[2].value!=64u||args[3].kind!=PL_OPERAND_CONST||args[3].value!=~0ull))goto bad;
        for(pl_u32 a=0u;a<arity;++a){if(!operand_valid(p,args[a],n))goto bad;mark_projection(p,args[a],projections);}
    }
    for(pl_u32 i=0u;i<count;++i){if(!operand_valid(p,p->locals[i],p->node_count))goto bad;mark_projection(p,p->locals[i],projections);}
    for(pl_u32 n=0u;n<p->node_count;++n){const pl_node *node=p->nodes+n;const pl_operand *a=p->arguments+node->argument_at;
        if(node->opcode==PL_OPCODE_X86_COMPARE){
            pl_u8 live=projections[n+1u];
            if(live&1u){operand_emit(c,a[1],input,first,projections);operand_emit(c,a[2],input,first,projections);cut_op(c,0x54u);cut_op(c,0xadu);}
            if(live&2u){operand_emit(c,a[1],input,first,projections);operand_emit(c,a[2],input,first,projections);cut_op(c,0x51u);cut_op(c,0xadu);}
            if(live==3u){cut_const(c,6u);cut_op(c,0x86u);cut_op(c,0x84u);}
            if(!live)cut_const(c,0u);
        }else if(node->opcode==PL_OPCODE_X86_BIT_SUMMARY){cut_const(c,63u);operand_emit(c,a[1],input,first,projections);cut_op(c,0x79u);cut_op(c,0x7du);
        }else if(node->opcode==PL_OPCODE_X86_DIVIDE){
            // Only the unsigned one-word quotient projection is accepted.
            // Its plan proves nonzero, but keep arbitrary malformed inputs
            // engine-total too; the caller owns the separate #DE predicate.
            operand_emit(c,a[1],input,first,projections);operand_emit(c,a[2],input,first,projections);cut_const(c,1u);
            operand_emit(c,a[2],input,first,projections);cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0x1bu);cut_op(c,0x80u);
        }else{
            operand_emit(c,a[0],input,first,projections);operand_emit(c,a[1],input,first,projections);
            if(node->opcode==PL_OPCODE_LANE64_SELECT){operand_emit(c,a[2],input,first,projections);cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0x1bu);}
            else cut_op(c,node->opcode==86u?0x85u:node->opcode==87u?0x83u:node->opcode==88u?0x84u:node->opcode==89u?0x7cu:node->opcode==96u?0x7du
                :node->opcode==PL_OPCODE_MULR?0x7eu:node->opcode==PL_OPCODE_LANE64_SHL?0x86u:node->opcode==PL_OPCODE_LANE64_SAR?0x87u:0x88u);
        }
        cut_set(c,first+n);
    }
    for(pl_u32 i=0u;i<count;++i){operand_emit(c,p->locals[i],input,first,projections);cut_set(c,output[i]);}return;
bad:c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;
}
void cut_emit_scalar_plan(cut_lowering *c,const pl_plan *p,const pl_u32 *input,pl_u32 first,const pl_u32 output[3])
{cut_emit_scalar_projection(c,p,input,first,output,3u);}
