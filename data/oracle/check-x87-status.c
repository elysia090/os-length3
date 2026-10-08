#include <machine/state.h>
#include "../../src/v2/x86/check/scalar-plan.h"
#include <stdio.h>
static machine_state states[256][2];static pl_u64 operands[256];
static int read(const char *dir,pl_u32 form,const char *suffix,void *bytes,size_t n)
{
    char path[4096];int size=snprintf(path,sizeof path,"%s/x87-status-%u.%s",dir,form,suffix);
    if(size<1||(size_t)size>=sizeof path)return 1;
    FILE *file=fopen(path,"rb");if(!file)return 1;
    int bad=fread(bytes,1u,n,file)!=n;if(!bad&&fgetc(file)!=EOF)bad=1;if(fclose(file))bad=1;return bad;
}
int main(int argc,char **argv)
{
    if(argc!=2)return 2;
    pl_u32 samples=0u,max_nodes=0u,max_span=0u;
    for(pl_u32 form=0u;form<172u;++form){pl_u32 family=form<168u?form%42u:42u,memory=family<8u,integer=family>=4u;
        if(read(argv[1],form,"cases",states,sizeof states)||read(argv[1],form,"operands",operands,sizeof operands))return 2;
        pl_u32 source=family==42u?0u:family<40u?(family-8u)&7u:1u,ordered=family<8u||family>=40u?family!=41u:(family-8u)/8u<2u;
        _Alignas(8) pl_u8 scratch[65536];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;
        pl_u32 bits=integer?(family<6u?16u:32u):(family<2u?32u:64u);
        int status=memory?pl_x86_x87_memory_relation_plan(bits,integer,&arena,&plan):
            family==42u?pl_x86_x87_zero_relation_plan(&arena,&plan):pl_x86_x87_relation_plan(ordered,!source,&arena,&plan);
        if(status){fprintf(stderr,"status relation plan %u: %d arena=%u\n",form,status,arena.used);return 1;}
        if(plan.node_count>max_nodes)max_nodes=plan.node_count;
        if(plan.span>max_span)max_span=plan.span;
        for(pl_u32 row=0u;row<256u;++row){const machine_state *a=states[row],*b=a+1u;pl_u32 top=(a->x87_status>>11u)&7u,other=(top+source)&7u;
            pl_u64 empty=((a->x87_tag>>(top*2u))&3u)==3u;
            if(!memory)empty|=((a->x87_tag>>(other*2u))&3u)==3u;
            pl_u64 input[]={a->x87_significand[top],a->x87_sign_exponent[top],memory?operands[row]:a->x87_significand[other],
                memory?0u:a->x87_sign_exponent[other],empty},out[3]={0u};
            if(check_scalar_plan(&plan,input,out)||out[0]!=((b->x87_status&0x4500u)>>8u)||out[1]!=(b->x87_status&0x43u)){
                fprintf(stderr,"status relation differs form=%u row=%u flags=%llx/%x raised=%llx/%x\n",form,row,
                    (unsigned long long)out[0],(b->x87_status&0x4500u)>>8u,(unsigned long long)out[1],b->x87_status&0x43u);return 1;}
            ++samples;
        }
    }
    printf("{\"format\":\"status-relation-ssa-hardware-v1\",\"status\":\"pass\",\"comparisons\":%u,\"maxAbstractWork\":%u,\"maxAbstractSpan\":%u,\"stateEffects\":\"tested separately\"}\n",samples,max_nodes,max_span);return 0;
}
