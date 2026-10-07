#include <softfloat.h>
#include <machine/state.h>
#include <stdio.h>
#include <string.h>
/* SoftFloat is only a reference for canonical inputs with masked results.
 * Physical observations outside this domain are kept for the compiler gate. */
static int read(const char *dir,pl_u32 form,const char *suffix,void *bytes,size_t n)
{
    char path[4096];int size=snprintf(path,sizeof path,"%s/x87-arithmetic-%u.%s",dir,form,suffix);
    if(size<1||(size_t)size>=sizeof path)return 1;
    FILE *file=fopen(path,"rb");if(!file)return 1;
    int bad=fread(bytes,1u,n,file)!=n;if(!bad&&fgetc(file)!=EOF)bad=1;if(fclose(file))bad=1;return bad;
}
int main(int argc,char **argv)
{
    if(argc!=2)return 2;
    const pl_u8 rounding[]={softfloat_round_near_even,softfloat_round_min,softfloat_round_max,softfloat_round_minMag};
    pl_u32 compared=0u,excluded=0u,changed_pending[6]={0u},kept_pending[6]={0u};
    for(pl_u32 form=0u;form<576u;++form){machine_state states[64][2];pl_u64 integers[64];
        if(read(argv[1],form,"cases",states,sizeof states)||read(argv[1],form,"integers",integers,sizeof integers))return 2;
        pl_u32 width=(form&1u)?16u:32u,operation=(form/2u)%3u,mode=form/6u,pc=mode&3u,rc=(mode>>2u)&3u;
        extF80_roundingPrecision=pc==0u?32u:pc==2u?64u:80u;softfloat_roundingMode=rounding[rc];
        softfloat_detectTininess=softfloat_tininess_afterRounding;
        for(pl_u32 row=0u;row<64u;++row){const machine_state *a=states[row],*b=a+1u;pl_u32 top=(a->x87_status>>11u)&7u;
            pl_u64 sig=a->x87_significand[top];pl_u16 se=a->x87_sign_exponent[top];pl_u32 exp=se&0x7fffu;
            int changed=sig!=b->x87_significand[top]||se!=b->x87_sign_exponent[top];
            for(pl_u32 bit=0u;bit<6u;++bit)if((b->x87_status&~a->x87_control)&(1u<<bit)){
                if(changed)++changed_pending[bit];else ++kept_pending[bit];}
            if(mode>=16u||pc==1u||((a->x87_tag>>(top*2u))&3u)==3u
                ||(!exp&&(sig>>63u))||(exp&&!(sig>>63u))||exp==0x7fffu){++excluded;continue;}
            pl_u64 mask=(1ull<<width)-1u,sign=1ull<<(width-1u),bits=((integers[row]&mask)^sign)-sign;
            int64_t integer;memcpy(&integer,&bits,sizeof integer);extFloat80_t x={.signif=sig,.signExp=se};
            softfloat_exceptionFlags=0u;extFloat80_t y=i64_to_extF80(integer);
            extFloat80_t expected=operation==0u?extF80_sub(x,y):operation==1u?extF80_add(x,y):extF80_sub(y,x);
            pl_u32 raised=((softfloat_exceptionFlags&softfloat_flag_inexact)?32u:0u)
                |((softfloat_exceptionFlags&softfloat_flag_underflow)?16u:0u)|((softfloat_exceptionFlags&softfloat_flag_overflow)?8u:0u);
            if(expected.signif!=b->x87_significand[top]||expected.signExp!=b->x87_sign_exponent[top]||(b->x87_status&56u)!=raised){
                fprintf(stderr,"masked arithmetic reference differs form=%u row=%u expected=%016llx/%04x flags=%02x native=%016llx/%04x flags=%02x\n",
                    form,row,(unsigned long long)expected.signif,expected.signExp,raised,(unsigned long long)b->x87_significand[top],
                    b->x87_sign_exponent[top],b->x87_status&56u);return 1;}
            ++compared;
        }
    }
    printf("{\"format\":\"native-x87-softfloat-arithmetic-v1\",\"status\":\"pass\",\"canonicalMaskedComparisons\":%u,\"outsideReferenceDomain\":%u,\"unmaskedPayloadChanged\":[%u,%u,%u,%u,%u,%u],\"unmaskedPayloadKept\":[%u,%u,%u,%u,%u,%u],\"linuxBoot\":\"not-tested\"}\n",
        compared,excluded,changed_pending[0],changed_pending[1],changed_pending[2],changed_pending[3],changed_pending[4],changed_pending[5],
        kept_pending[0],kept_pending[1],kept_pending[2],kept_pending[3],kept_pending[4],kept_pending[5]);return 0;
}
