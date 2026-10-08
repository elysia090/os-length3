#include <softfloat.h>
#include <machine/state.h>
#include <stdio.h>
/* Independent numeric reference only. Stack, deferred errors, noncanonical
 * values and unmasked publication remain in the full-state hardware gate. */
static machine_state states[1536][2];
static int read_form(const char *dir,pl_u32 form,const char *suffix,void *data,size_t bytes)
{
    char path[4096];int n=snprintf(path,sizeof path,"%s/x87-register-%u.%s",dir,form,suffix);
    if(n<1||(size_t)n>=sizeof path)return 1;
    FILE *file=fopen(path,"rb");if(!file)return 1;
    int bad=fread(data,1u,bytes,file)!=bytes;if(!bad&&fgetc(file)!=EOF)bad=1;if(fclose(file))bad=1;return bad;
}
static int canonical(extFloat80_t a)
{
    pl_u32 exp=a.signExp&0x7fffu;return exp?!!(a.signif>>63u):!(a.signif>>63u);
}
int main(int argc,char **argv)
{
    if(argc!=2)return 2;
    const pl_u8 rounding[]={softfloat_round_near_even,softfloat_round_min,softfloat_round_max,softfloat_round_minMag};
    pl_u32 compared=0u,outside=0u;
    for(pl_u32 form=0u;form<81u;++form){pl_u8 code[2];pl_u32 rows=form<72u?400u:1536u;
        if(read_form(argv[1],form,"source",code,sizeof code)||read_form(argv[1],form,"cases",states,(size_t)rows*sizeof states[0]))return 2;
        pl_u32 index=code[1]&7u,group=(code[1]>>3u)&7u,other_destination=code[0]!=0xd8u;
        if((code[0]!=0xd8u&&code[0]!=0xdcu&&code[0]!=0xdeu)||(code[1]&0xc0u)!=0xc0u
            ||(group!=0u&&group!=4u&&group!=5u))return 2;
        for(pl_u32 row=0u;row<rows;++row){const machine_state *before=states[row],*after=before+1u;
            pl_u32 top=(before->x87_status>>11u)&7u,dst=(top+(other_destination?index:0u))&7u;
            pl_u32 src=(top+(other_destination?0u:index))&7u,pc=(before->x87_control>>8u)&3u;
            extFloat80_t a={.signif=before->x87_significand[dst],.signExp=before->x87_sign_exponent[dst]};
            extFloat80_t b={.signif=before->x87_significand[src],.signExp=before->x87_sign_exponent[src]};
            if((before->x87_control&63u)!=63u||pc==1u||((before->x87_tag>>(dst*2u))&3u)==3u
                ||((before->x87_tag>>(src*2u))&3u)==3u||!canonical(a)||!canonical(b)){++outside;continue;}
            extF80_roundingPrecision=pc==0u?32u:pc==2u?64u:80u;
            softfloat_roundingMode=rounding[(before->x87_control>>10u)&3u];
            softfloat_detectTininess=softfloat_tininess_afterRounding;softfloat_exceptionFlags=0u;
            int reverse=other_destination?group==4u:group==5u;
            extFloat80_t result=group==0u?extF80_add(a,b):reverse?extF80_sub(b,a):extF80_sub(a,b);
            pl_u32 flags=((softfloat_exceptionFlags&softfloat_flag_invalid)?1u:0u)
                |((softfloat_exceptionFlags&softfloat_flag_overflow)?8u:0u)
                |((softfloat_exceptionFlags&softfloat_flag_underflow)?16u:0u)
                |((softfloat_exceptionFlags&softfloat_flag_inexact)?32u:0u);
            if(result.signif!=after->x87_significand[dst]||result.signExp!=after->x87_sign_exponent[dst]
                ||flags!=(after->x87_status&0x39u)){
                fprintf(stderr,"register reference differs %u/%u (%02x%02x): expected %016llx/%04x/%02x, native %016llx/%04x/%02x\n",
                    form,row,code[0],code[1],(unsigned long long)result.signif,result.signExp,flags,
                    (unsigned long long)after->x87_significand[dst],after->x87_sign_exponent[dst],after->x87_status&0x39u);return 1;}
            ++compared;
        }
    }
    printf("{\"format\":\"native-x87-register-softfloat-v1\",\"status\":\"pass\",\"canonicalMaskedComparisons\":%u,\"outsideReferenceDomain\":%u,\"productRuntime\":false,\"linuxBoot\":\"not-tested\"}\n",compared,outside);return 0;
}
