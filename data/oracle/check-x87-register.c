#include <softfloat.h>
#include <machine/state.h>
#include "../../src/v2/x86/check/scalar-plan.h"
#include <stdio.h>
#include <string.h>
/* Independent numeric reference only. Stack, deferred errors, noncanonical
 * values and unmasked publication remain in the full-state hardware gate. */
static machine_state states[1536][2];
static const char *record_prefix="x87-register";
static int read_form(const char *dir,pl_u32 form,const char *suffix,void *data,size_t bytes)
{
    char path[4096];int n=snprintf(path,sizeof path,"%s/%s-%u.%s",dir,record_prefix,form,suffix);
    if(n<1||(size_t)n>=sizeof path)return 1;
    FILE *file=fopen(path,"rb");if(!file)return 1;
    int bad=fread(data,1u,bytes,file)!=bytes;if(!bad&&fgetc(file)!=EOF)bad=1;if(fclose(file))bad=1;return bad;
}
static int canonical(extFloat80_t a)
{
    pl_u32 exp=a.signExp&0x7fffu;return exp?!!(a.signif>>63u):!(a.signif>>63u);
}
static pl_u64 sample(pl_u64 *state)
{*state^=*state<<13u;*state^=*state>>7u;*state^=*state<<17u;return *state;}
static int finite(void)
{
    const pl_u8 rounding[]={softfloat_round_near_even,softfloat_round_min,softfloat_round_max,softfloat_round_minMag},precision[]={0u,2u,3u};
    pl_u32 count=0u;pl_u64 seed=0x13579bdf2468ace1ull;
    for(pl_u32 op=0u;op<6u;++op){_Alignas(8) pl_u8 scratch[131072];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;
        if(pl_x86_x87_register_arithmetic_plan(op,&arena,&plan))return 1;
        for(pl_u32 n=0u;n<80000u;++n){pl_u32 pc=precision[n%3u],rc=(n/3u)&3u;
            pl_u32 ea=(pl_u32)(sample(&seed)%32767u),eb=(pl_u32)(sample(&seed)%32767u);
            if(n&3u){pl_u32 distance=(pl_u32)(sample(&seed)%130u);eb=ea>distance?ea-distance:0u;}
            if((n&31u)==1u)ea=eb=0u;
            if((n&31u)==2u){ea=1u;eb=0u;}
            if((n&31u)==3u)ea=eb=32766u;
            pl_u64 a=sample(&seed),b=sample(&seed);pl_u16 sa=(pl_u16)(ea|((sample(&seed)&1u)<<15u)),sb=(pl_u16)(eb|((sample(&seed)&1u)<<15u));
            a=ea?a|0x8000000000000000ull:a&0x7fffffffffffffffull;
            b=eb?b|0x8000000000000000ull:b&0x7fffffffffffffffull;
            if(!(n&7u)){eb=ea;b=a-(a&63u);sb=(pl_u16)(ea|(sa&0x8000u));if(!op)sb^=0x8000u;}
            if((n&31u)==4u){a=0u;sa&=0x8000u;}
            pl_u64 input[]={a,sa,b,sb,0x7fu|(pc<<8u)|(rc<<10u),0u},out[3];if(check_scalar_plan(&plan,input,out))return 1;
            extFloat80_t x={.signif=a,.signExp=sa},y={.signif=b,.signExp=sb};
            extF80_roundingPrecision=pc==0u?32u:pc==2u?64u:80u;softfloat_roundingMode=rounding[rc];
            softfloat_detectTininess=softfloat_tininess_afterRounding;softfloat_exceptionFlags=0u;
            extFloat80_t expected=op==0u?extF80_add(x,y):op==1u?extF80_mul(x,y):op==2u?extF80_sub(x,y):op==3u?extF80_sub(y,x):op==4u?extF80_div(x,y):extF80_div(y,x);
            pl_u32 flags=((softfloat_exceptionFlags&softfloat_flag_invalid)?1u:0u)|((softfloat_exceptionFlags&softfloat_flag_infinite)?4u:0u)
                |((softfloat_exceptionFlags&softfloat_flag_overflow)?8u:0u)
                |((softfloat_exceptionFlags&softfloat_flag_underflow)?16u:0u)|((softfloat_exceptionFlags&softfloat_flag_inexact)?32u:0u);
            if(out[0]!=expected.signif||out[1]!=expected.signExp||(out[2]&61u)!=flags||(out[2]&(1u<<16u))){
                fprintf(stderr,"finite register SSA differs %u/%u PC=%u RC=%u\n",op,n,pc,rc);return 1;}
            ++count;
        }
    }
    printf("{\"format\":\"finite-register-arithmetic-v1\",\"status\":\"pass\",\"canonicalFiniteComparisons\":%u,\"fullStateHardware\":false,\"linuxBoot\":\"not-tested\"}\n",count);return 0;
}
int main(int argc,char **argv)
{
    if(argc==2&&!strcmp(argv[1],"--finite"))return finite();
    int ssa=0,divide=0,multiply=0;
    if(argc<2||argc>4)return 2;
    for(int n=2;n<argc;++n){if(!strcmp(argv[n],"--ssa"))ssa=1;else if(!strcmp(argv[n],"--divide"))divide=1;else if(!strcmp(argv[n],"--multiply"))multiply=1;else return 2;}
    if(divide&&multiply)return 2;
    if(divide)record_prefix="x87-register-divide";
    if(multiply)record_prefix="x87-register-multiply";
    const pl_u8 rounding[]={softfloat_round_near_even,softfloat_round_min,softfloat_round_max,softfloat_round_minMag};
    pl_u32 compared=0u,outside=0u,ssa_rows=0u,max_work=0u,max_span=0u,max_arena=0u;
    for(pl_u32 form=0u;form<(multiply?27u:divide?54u:81u);++form){pl_u8 code[2];pl_u32 rows=form<(multiply?24u:divide?48u:72u)?400u:1536u;
        if(read_form(argv[1],form,"source",code,sizeof code)||read_form(argv[1],form,"cases",states,(size_t)rows*sizeof states[0]))return 2;
        pl_u32 index=code[1]&7u,group=(code[1]>>3u)&7u,other_destination=code[0]!=0xd8u;
        if((code[0]!=0xd8u&&code[0]!=0xdcu&&code[0]!=0xdeu)||(code[1]&0xc0u)!=0xc0u
            ||(multiply?group!=1u:divide?(group!=6u&&group!=7u):(group!=0u&&group!=4u&&group!=5u)))return 2;
        int reverse=other_destination?group==(divide?6u:4u):group==(divide?7u:5u);
        _Alignas(8) pl_u8 scratch[131072];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;
        if(ssa){int status=pl_x86_x87_register_arithmetic_plan(multiply?1u:divide?(reverse?5u:4u):group==0u?0u:reverse?3u:2u,&arena,&plan);
            if(status){fprintf(stderr,"register SSA construction %u: %d, arena %u\n",form,status,arena.used);return 1;}
            if(plan.node_count>max_work)max_work=plan.node_count;
            if(plan.span>max_span)max_span=plan.span;
            if(arena.used>max_arena)max_arena=arena.used;}
        for(pl_u32 row=0u;row<rows;++row){const machine_state *before=states[row],*after=before+1u;
            pl_u32 top=(before->x87_status>>11u)&7u,dst=(top+(other_destination?index:0u))&7u;
            pl_u32 src=(top+(other_destination?0u:index))&7u,pc=(before->x87_control>>8u)&3u;
            extFloat80_t a={.signif=before->x87_significand[dst],.signExp=before->x87_sign_exponent[dst]};
            extFloat80_t b={.signif=before->x87_significand[src],.signExp=before->x87_sign_exponent[src]};
            if(ssa){pl_u32 empty=(((before->x87_tag>>(dst*2u))&3u)==3u)||(((before->x87_tag>>(src*2u))&3u)==3u);
                pl_u64 input[]={a.signif,a.signExp,b.signif,b.signExp,before->x87_control,empty},out[3];
                if(check_scalar_plan(&plan,input,out))return 1;
                pl_u64 sig=(out[2]&(1u<<16u))?a.signif:out[0],se=(out[2]&(1u<<16u))?a.signExp:out[1];
                if(sig!=after->x87_significand[dst]||se!=after->x87_sign_exponent[dst]||(out[2]&0x27fu)!=(after->x87_status&0x27fu)
                    ||(!(out[2]&(1u<<16u))&&code[0]!=0xdeu&&((out[2]>>18u)&3u)!=((after->x87_tag>>(dst*2u))&3u))){
                    fprintf(stderr,"register SSA differs %u/%u (%02x%02x): %016llx/%04llx/%05llx vs %016llx/%04x/%04x\n",form,row,code[0],code[1],
                        (unsigned long long)sig,(unsigned long long)se,(unsigned long long)out[2],(unsigned long long)after->x87_significand[dst],
                        after->x87_sign_exponent[dst],after->x87_status);return 1;}
                ++ssa_rows;}
            if((before->x87_control&63u)!=63u||pc==1u||((before->x87_tag>>(dst*2u))&3u)==3u
                ||((before->x87_tag>>(src*2u))&3u)==3u||!canonical(a)||!canonical(b)){++outside;continue;}
            extF80_roundingPrecision=pc==0u?32u:pc==2u?64u:80u;
            softfloat_roundingMode=rounding[(before->x87_control>>10u)&3u];
            softfloat_detectTininess=softfloat_tininess_afterRounding;softfloat_exceptionFlags=0u;
            extFloat80_t result=multiply?extF80_mul(a,b):divide?(reverse?extF80_div(b,a):extF80_div(a,b)):group==0u?extF80_add(a,b):reverse?extF80_sub(b,a):extF80_sub(a,b);
            pl_u32 flags=((softfloat_exceptionFlags&softfloat_flag_invalid)?1u:0u)
                |((softfloat_exceptionFlags&softfloat_flag_infinite)?4u:0u)
                |((softfloat_exceptionFlags&softfloat_flag_overflow)?8u:0u)
                |((softfloat_exceptionFlags&softfloat_flag_underflow)?16u:0u)
                |((softfloat_exceptionFlags&softfloat_flag_inexact)?32u:0u);
            if(result.signif!=after->x87_significand[dst]||result.signExp!=after->x87_sign_exponent[dst]
                ||flags!=((after->x87_status&0x3du)&~((after->x87_status&0x40u)?1u:0u))){
                fprintf(stderr,"register reference differs %u/%u (%02x%02x): expected %016llx/%04x/%02x, native %016llx/%04x/%02x\n",
                    form,row,code[0],code[1],(unsigned long long)result.signif,result.signExp,flags,
                    (unsigned long long)after->x87_significand[dst],after->x87_sign_exponent[dst],after->x87_status&0x39u);return 1;}
            ++compared;
        }
    }
    printf("{\"format\":\"native-x87-register-softfloat-v1\",\"status\":\"pass\",\"canonicalMaskedComparisons\":%u,\"outsideReferenceDomain\":%u,\"ssaHardwareRows\":%u,\"maxAbstractWork\":%u,\"maxAbstractSpan\":%u,\"maxArena\":%u,\"productRuntime\":false,\"linuxBoot\":\"not-tested\"}\n",compared,outside,ssa_rows,max_work,max_span,max_arena);return 0;
}
