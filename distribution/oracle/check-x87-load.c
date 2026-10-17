#include <softfloat.h>
#include <machine/state.h>
#include "../../compiler/x86/check/scalar-plan.h"
#include <stdio.h>
#include <string.h>
static machine_state states[64][2];static pl_u64 operands[64];
static int read_form(const char *dir,pl_u32 form,const char *suffix,void *data,size_t bytes)
{
    char path[4096];int n=snprintf(path,sizeof path,"%s/x87-ieee-load-%u.%s",dir,form,suffix);
    if(n<1||(size_t)n>=sizeof path)return 1;
    FILE *file=fopen(path,"rb");if(!file)return 1;
    int bad=fread(data,1u,bytes,file)!=bytes;if(!bad&&fgetc(file)!=EOF)bad=1;if(fclose(file))bad=1;return bad;
}
int main(int argc,char **argv)
{
    if(argc!=2)return 2;
    pl_u32 compared=0u,outside=0u,ssa_rows=0u,max_work=0u,max_span=0u,max_arena=0u;
    for(pl_u32 form=0u;form<96u;++form){pl_u32 bits=(form&1u)?64u:32u;
        if(read_form(argv[1],form,"cases",states,sizeof states)||read_form(argv[1],form,"integers",operands,sizeof operands))return 2;
        _Alignas(8) pl_u8 scratch[32768];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;
        if(pl_x86_x87_load_plan(bits,0u,&arena,&plan))return 1;
        if(plan.node_count>max_work)max_work=plan.node_count;
        if(plan.span>max_span)max_span=plan.span;
        if(arena.used>max_arena)max_arena=arena.used;
        for(pl_u32 row=0u;row<64u;++row){const machine_state *before=states[row],*after=before+1u;
            pl_u32 top=(before->x87_status>>11u)&7u,next=(top+7u)&7u,full=((before->x87_tag>>(next*2u))&3u)!=3u;
            pl_u64 input[]={operands[row],before->x87_control,full,0u,0u},out[3];if(check_scalar_plan(&plan,input,out))return 1;
            pl_u64 sig=out[2]&(1u<<16u)?before->x87_significand[next]:out[0],se=out[2]&(1u<<16u)?before->x87_sign_exponent[next]:out[1];
            if(sig!=after->x87_significand[next]||se!=after->x87_sign_exponent[next]||(out[2]&0x27fu)!=(after->x87_status&0x27fu)
                ||(!(out[2]&(1u<<16u))&&((out[2]>>18u)&3u)!=((after->x87_tag>>(next*2u))&3u))){
                fprintf(stderr,"load SSA differs %u/%u\n",form,row);return 1;}
            ++ssa_rows;
            if(full||(before->x87_control&3u)!=3u){++outside;continue;}
            softfloat_exceptionFlags=0u;extFloat80_t expected;
            if(bits==32u){float32_t x={.v=(uint32_t)operands[row]};expected=f32_to_extF80(x);}
            else{float64_t x={.v=operands[row]};expected=f64_to_extF80(x);}
            pl_u32 invalid=(softfloat_exceptionFlags&softfloat_flag_invalid)?1u:0u;
            if(expected.signif!=after->x87_significand[next]||expected.signExp!=after->x87_sign_exponent[next]||invalid!=(after->x87_status&1u)){
                fprintf(stderr,"load reference differs %u/%u\n",form,row);return 1;}
            ++compared;
        }
    }
    printf("{\"format\":\"native-x87-load-softfloat-v1\",\"status\":\"pass\",\"canonicalMaskedComparisons\":%u,\"outsideReferenceDomain\":%u,\"ssaHardwareRows\":%u,\"maxAbstractWork\":%u,\"maxAbstractSpan\":%u,\"maxArena\":%u,\"linuxBoot\":\"not-tested\"}\n",compared,outside,ssa_rows,max_work,max_span,max_arena);return 0;
}
