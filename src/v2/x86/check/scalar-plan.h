#ifndef CHECK_SCALAR_PLAN_H
#define CHECK_SCALAR_PLAN_H
#include <x86/semantics.h>
/* Oracle-only evaluation. Product execution emits ordinary instructions. */
static pl_u64 check_scalar_nodes[PL_X86_X87_RELATION_MAX_NODES+1u];
static pl_u64 check_scalar_value(pl_operand a,const pl_u64 input[5])
{
    if(a.kind==PL_OPERAND_CONST)return a.value;
    if(a.kind==PL_OPERAND_LOCAL)return input[a.value];
    if(a.kind==PL_OPERAND_NODE)return check_scalar_nodes[a.value];
    if(a.kind==PL_OPERAND_PROJECTION){pl_u64 v=check_scalar_nodes[a.value>>8u];
        return(a.value&255u)==16u?v:(a.value&255u)==2u?v&1u:(v>>6u)&1u;}
    return ~0ull;
}
static int check_scalar_plan(const pl_plan *p,const pl_u64 input[5],pl_u64 out[3])
{
    for(pl_u32 n=0u;n<p->node_count;++n){const pl_node *node=p->nodes+n;const pl_operand *arg=p->arguments+node->argument_at;
        pl_u64 a=check_scalar_value(arg[0],input),b=node->argument_count>1u?check_scalar_value(arg[1],input):0u,v;
        switch(node->opcode){case 86u:v=a^b;break;case 87u:v=a&b;break;case 88u:v=a|b;break;case 89u:v=a+b;break;case 96u:v=a-b;break;
        case PL_OPCODE_LANE64_SHL:v=a<<(b&63u);break;case PL_OPCODE_LANE64_SHR:v=a>>(b&63u);break;
        case PL_OPCODE_LANE64_SAR:b&=63u;v=(a>>b)|(b&&(a>>63u)?~0ull<<(64u-b):0u);break;
        case PL_OPCODE_LANE64_SELECT:v=check_scalar_value(arg[2],input)?a:b;break;
        case PL_OPCODE_X86_COMPARE:a=check_scalar_value(arg[1],input);b=check_scalar_value(arg[2],input);v=(a<b?1u:0u)|(a==b?64u:0u);break;
        case PL_OPCODE_X86_BIT_SUMMARY:a=check_scalar_value(arg[1],input);v=~0ull;for(pl_u32 k=0u;k<64u;++k)if((a>>k)&1u)v=k;break;
        default:return 1;}check_scalar_nodes[n+1u]=v;
    }
    for(pl_u32 i=0u;i<3u;++i)out[i]=check_scalar_value(p->locals[i],input);
    return 0;
}
#endif
