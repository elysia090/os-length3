#ifndef CHECK_SCALAR_PLAN_H
#define CHECK_SCALAR_PLAN_H
#include <x86/semantics.h>
/* Oracle-only evaluation. Product execution emits ordinary instructions. */
static pl_u64 check_scalar_nodes[PL_X86_X87_ARITHMETIC_MAX_NODES+1u];
static pl_u8 check_scalar_quotients[PL_X86_X87_ARITHMETIC_MAX_NODES+1u];
static pl_u64 check_scalar_value(pl_operand a,const pl_u64 *input)
{
    if(a.kind==PL_OPERAND_CONST)return a.value;
    if(a.kind==PL_OPERAND_LOCAL)return input[a.value];
    if(a.kind==PL_OPERAND_NODE)return check_scalar_nodes[a.value];
    if(a.kind==PL_OPERAND_PROJECTION){pl_u64 v=check_scalar_nodes[a.value>>8u];
        if(check_scalar_quotients[a.value>>8u]&&(a.value&255u)==0u)return v;
        return(a.value&255u)==16u?v:(a.value&255u)==2u?v&1u:(v>>6u)&1u;}
    return ~0ull;
}
static int check_scalar_projection(const pl_plan *p,const pl_u64 *input,pl_u64 *out,pl_u32 count)
{
    if(!p||!input||!out||!count||count>p->local_count||p->node_count>PL_X86_X87_ARITHMETIC_MAX_NODES)return 1;
    for(pl_u32 n=0u;n<p->node_count;++n){const pl_node *node=p->nodes+n;const pl_operand *arg=p->arguments+node->argument_at;
        pl_u64 a=check_scalar_value(arg[0],input),b=node->argument_count>1u?check_scalar_value(arg[1],input):0u,v;
        check_scalar_quotients[n+1u]=(pl_u8)(node->opcode==PL_OPCODE_X86_DIVIDE);
        switch(node->opcode){case 86u:v=a^b;break;case 87u:v=a&b;break;case 88u:v=a|b;break;case 89u:v=a+b;break;case 96u:v=a-b;break;
        case PL_OPCODE_MULR:v=a*b;break;
        case PL_OPCODE_X86_DIVIDE:if(a||node->argument_count!=4u||arg[3].kind!=PL_OPERAND_CONST||arg[3].value!=64u)return 1;
            a=b;b=check_scalar_value(arg[2],input);if(!b)return 1;v=a/b;break;
        case PL_OPCODE_LANE64_SHL:v=a<<(b&63u);break;case PL_OPCODE_LANE64_SHR:v=a>>(b&63u);break;
        case PL_OPCODE_LANE64_SAR:b&=63u;v=(a>>b)|(b&&(a>>63u)?~0ull<<(64u-b):0u);break;
        case PL_OPCODE_LANE64_SELECT:v=check_scalar_value(arg[2],input)?a:b;break;
        case PL_OPCODE_X86_COMPARE:a=check_scalar_value(arg[1],input);b=check_scalar_value(arg[2],input);v=(a<b?1u:0u)|(a==b?64u:0u);break;
        case PL_OPCODE_X86_BIT_SUMMARY:a=check_scalar_value(arg[1],input);v=~0ull;for(pl_u32 k=0u;k<64u;++k)if((a>>k)&1u)v=k;break;
        default:return 1;}check_scalar_nodes[n+1u]=v;
    }
    for(pl_u32 i=0u;i<count;++i)out[i]=check_scalar_value(p->locals[i],input);
    return 0;
}
static inline int check_scalar_plan(const pl_plan *p,const pl_u64 *input,pl_u64 out[3])
{return check_scalar_projection(p,input,out,3u);}
#endif
