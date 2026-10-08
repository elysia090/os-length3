#include <softfloat.h>
#include <machine/state.h>
#include "../../src/v2/x86/check/scalar-plan.h"
#include <stdio.h>
#include <string.h>
/* SoftFloat is only a reference for canonical inputs with masked results.
 * Physical observations outside this domain are kept for the compiler gate. */
static const char *prefix="x87-arithmetic";
static int read(const char *dir,pl_u32 form,const char *suffix,void *bytes,size_t n)
{
    char path[4096];int size=snprintf(path,sizeof path,"%s/%s-%u.%s",dir,prefix,form,suffix);
    if(size<1||(size_t)size>=sizeof path)return 1;
    FILE *file=fopen(path,"rb");if(!file)return 1;
    int bad=fread(bytes,1u,n,file)!=n;if(!bad&&fgetc(file)!=EOF)bad=1;if(fclose(file))bad=1;return bad;
}
int main(int argc,char **argv)
{
    int ssa=0,divide=0;if(argc<2||argc>4)return 2;
    for(int option=2;option<argc;++option){if(!strcmp(argv[option],"--ssa")&&!ssa)ssa=1;
        else if(!strcmp(argv[option],"--divide")&&!divide)divide=1;else return 2;}
    if(divide)prefix="x87-division";
    const pl_u8 rounding[]={softfloat_round_near_even,softfloat_round_min,softfloat_round_max,softfloat_round_minMag};
    pl_u32 compared=0u,excluded=0u,ssa_rows=0u,max_nodes=0u,max_span=0u,max_arena=0u,changed_pending[6]={0u},kept_pending[6]={0u};
    pl_u32 forms=divide?448u:576u,rows=divide?128u:64u,operations=divide?2u:3u;
    for(pl_u32 form=0u;form<forms;++form){machine_state states[128][2];pl_u64 integers[128];
        if(read(argv[1],form,"cases",states,(size_t)rows*sizeof states[0])||read(argv[1],form,"integers",integers,(size_t)rows*sizeof integers[0]))return 2;
        pl_u32 width=(form&1u)?16u:32u,operation=(form/2u)%operations,mode=form/(operations*2u),pc=mode&3u,rc=(mode>>2u)&3u;
        _Alignas(8) pl_u8 scratch[196608];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;
        if(ssa){int status=pl_x86_x87_integer_arithmetic_plan(width,divide?(operation?4u:5u):operation==0u?2u:operation==1u?0u:3u,&arena,&plan);
            if(status){fprintf(stderr,"arithmetic plan status=%d form=%u arena=%u\n",status,form,arena.used);return 1;}
            if(plan.node_count>max_nodes)max_nodes=plan.node_count;
            if(plan.span>max_span)max_span=plan.span;
            if(arena.used>max_arena)max_arena=arena.used;}
        extF80_roundingPrecision=pc==0u?32u:pc==2u?64u:80u;softfloat_roundingMode=rounding[rc];
        softfloat_detectTininess=softfloat_tininess_afterRounding;
        for(pl_u32 row=0u;row<rows;++row){const machine_state *a=states[row],*b=a+1u;pl_u32 top=(a->x87_status>>11u)&7u;
            pl_u64 sig=a->x87_significand[top];pl_u16 se=a->x87_sign_exponent[top];pl_u32 exp=se&0x7fffu;
            int changed=sig!=b->x87_significand[top]||se!=b->x87_sign_exponent[top];
            if(ssa){pl_u64 input[]={sig,se,integers[row],a->x87_control,((a->x87_tag>>(top*2u))&3u)==3u},out[3];
                if(check_scalar_plan(&plan,input,out)){fprintf(stderr,"unknown scalar node\n");return 1;}
                pl_u64 expected_sig=(out[2]&(1u<<16u))?sig:out[0],expected_se=(out[2]&(1u<<16u))?se:out[1];
                if(expected_sig!=b->x87_significand[top]||expected_se!=b->x87_sign_exponent[top]
                    ||(out[2]&0x27fu)!=(b->x87_status&0x27fu)
                    ||(!(out[2]&(1u<<16u))&&((out[2]>>18u)&3u)!=((b->x87_tag>>(top*2u))&3u))){
                    fprintf(stderr,"arithmetic SSA differs form=%u row=%u expected=%016llx/%04llx outcome=%llx native=%016llx/%04x flags=%04x\n",
                        form,row,(unsigned long long)expected_sig,(unsigned long long)expected_se,(unsigned long long)out[2],
                        (unsigned long long)b->x87_significand[top],b->x87_sign_exponent[top],b->x87_status&0x27fu);return 1;}
                ++ssa_rows;}
            for(pl_u32 bit=0u;bit<6u;++bit)if((b->x87_status&~a->x87_control)&(1u<<bit)){
                if(changed)++changed_pending[bit];else ++kept_pending[bit];}
            if(mode>=16u||pc==1u||((a->x87_tag>>(top*2u))&3u)==3u
                ||(!exp&&(sig>>63u))||(exp&&!(sig>>63u))||exp==0x7fffu){++excluded;continue;}
            pl_u64 mask=(1ull<<width)-1u,sign=1ull<<(width-1u),bits=((integers[row]&mask)^sign)-sign;
            int64_t integer;memcpy(&integer,&bits,sizeof integer);extFloat80_t x={.signif=sig,.signExp=se};
            softfloat_exceptionFlags=0u;extFloat80_t y=i64_to_extF80(integer);
            extFloat80_t expected=divide?(operation==0u?extF80_div(y,x):extF80_div(x,y)):
                operation==0u?extF80_sub(x,y):operation==1u?extF80_add(x,y):extF80_sub(y,x);
            pl_u32 raised=((softfloat_exceptionFlags&softfloat_flag_inexact)?32u:0u)
                |((softfloat_exceptionFlags&softfloat_flag_underflow)?16u:0u)|((softfloat_exceptionFlags&softfloat_flag_overflow)?8u:0u);
            if(divide)raised|=((softfloat_exceptionFlags&softfloat_flag_invalid)?1u:0u)|((softfloat_exceptionFlags&softfloat_flag_infinite)?4u:0u);
            if(expected.signif!=b->x87_significand[top]||expected.signExp!=b->x87_sign_exponent[top]||(b->x87_status&(divide?61u:56u))!=raised){
                fprintf(stderr,"masked arithmetic reference differs form=%u row=%u expected=%016llx/%04x flags=%02x native=%016llx/%04x flags=%02x\n",
                    form,row,(unsigned long long)expected.signif,expected.signExp,raised,(unsigned long long)b->x87_significand[top],
                    b->x87_sign_exponent[top],b->x87_status&(divide?61u:56u));return 1;}
            ++compared;
        }
    }
    printf("{\"format\":\"native-x87-softfloat-arithmetic-v1\",\"status\":\"pass\",\"canonicalMaskedComparisons\":%u,\"outsideReferenceDomain\":%u,\"ssaHardwareRows\":%u,\"maxAbstractWork\":%u,\"maxAbstractSpan\":%u,\"maxArena\":%u,\"unmaskedPayloadChanged\":[%u,%u,%u,%u,%u,%u],\"unmaskedPayloadKept\":[%u,%u,%u,%u,%u,%u],\"linuxBoot\":\"not-tested\"}\n",
        compared,excluded,ssa_rows,max_nodes,max_span,max_arena,changed_pending[0],changed_pending[1],changed_pending[2],changed_pending[3],changed_pending[4],changed_pending[5],
        kept_pending[0],kept_pending[1],kept_pending[2],kept_pending[3],kept_pending[4],kept_pending[5]);return 0;
}
