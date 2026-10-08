#include <softfloat.h>
#include <machine/state.h>
#include "../../src/v2/x86/check/scalar-plan.h"
#include <stdio.h>
#include <string.h>
/* Independent canonical integer conversion. Raw/empty/unmasked publication
 * is checked against hardware, not certified by the reference library. */
static machine_state states[64][2];static pl_u64 initial[64],written[64];
static int read_form(const char *dir,pl_u32 form,const char *suffix,void *data,size_t bytes)
{
    char path[4096];int n=snprintf(path,sizeof path,"%s/x87-integer-store-%u.%s",dir,form,suffix);
    if(n<1||(size_t)n>=sizeof path)return 1;
    FILE *file=fopen(path,"rb");if(!file)return 1;
    int bad=fread(data,1u,bytes,file)!=bytes;if(!bad&&fgetc(file)!=EOF)bad=1;if(fclose(file))bad=1;return bad;
}
int main(int argc,char **argv)
{
    if(argc!=2)return 2;
    const pl_u8 widths[]={16u,32u,16u,32u,64u,16u,32u,64u};
    const pl_u8 rounding[]={softfloat_round_near_even,softfloat_round_min,softfloat_round_max,softfloat_round_minMag};
    pl_u32 compared=0u,outside=0u,ssa_rows=0u,max_work=0u,max_span=0u,max_arena=0u;
    for(pl_u32 form=0u;form<384u;++form){pl_u32 bits=widths[form%8u],truncate=form%8u>=5u;pl_u64 mask=~0ull>>(64u-bits);
        if(read_form(argv[1],form,"cases",states,sizeof states)||read_form(argv[1],form,"integers",initial,sizeof initial)||read_form(argv[1],form,"written",written,sizeof written))return 2;
        _Alignas(8) pl_u8 scratch[65536];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;
        if(pl_x86_x87_integer_store_plan(bits,truncate,&arena,&plan))return 1;
        if(plan.node_count>max_work)max_work=plan.node_count;
        if(plan.span>max_span)max_span=plan.span;
        if(arena.used>max_arena)max_arena=arena.used;
        for(pl_u32 row=0u;row<64u;++row){const machine_state *before=states[row],*after=before+1u;pl_u32 top=(before->x87_status>>11u)&7u;
            extFloat80_t x={.signif=before->x87_significand[top],.signExp=before->x87_sign_exponent[top]};pl_u32 exp=x.signExp&32767u;
            pl_u32 empty=((before->x87_tag>>(top*2u))&3u)==3u;
            pl_u64 input[]={x.signif,x.signExp,before->x87_control,empty,0u},out[3];if(check_scalar_plan(&plan,input,out))return 1;
            pl_u64 expected=out[2]?initial[row]:(initial[row]&~mask)|(out[0]&mask);
            if(expected!=written[row]||(out[1]&0x27fu)!=(after->x87_status&0x27fu)){
                fprintf(stderr,"integer-store SSA differs %u/%u: %016llx/%llx vs %016llx/%04x\n",form,row,
                    (unsigned long long)expected,(unsigned long long)out[1],(unsigned long long)written[row],after->x87_status);return 1;}
            ++ssa_rows;
            if((before->x87_control&63u)!=63u||empty||(exp?!(x.signif>>63u):!!(x.signif>>63u))){++outside;continue;}
            softfloat_roundingMode=rounding[truncate?3u:(before->x87_control>>10u)&3u];softfloat_exceptionFlags=0u;
            int64_t converted=extF80_to_i64(x,softfloat_roundingMode,true);pl_u32 flags=(softfloat_exceptionFlags&softfloat_flag_invalid)?1u:(softfloat_exceptionFlags&softfloat_flag_inexact)?32u:0u;
            if(bits<64u&&(converted<-(int64_t)(1ull<<(bits-1u))||converted>(int64_t)((1ull<<(bits-1u))-1u)))flags=1u;
            pl_u64 value=flags&1u?1ull<<(bits-1u):(pl_u64)converted;expected=(initial[row]&~mask)|(value&mask);
            if(expected!=written[row]||flags!=(after->x87_status&0x21u)){
                fprintf(stderr,"integer-store reference differs %u/%u\n",form,row);return 1;}
            ++compared;
        }
    }
    printf("{\"format\":\"native-x87-integer-store-softfloat-v1\",\"status\":\"pass\",\"canonicalMaskedComparisons\":%u,\"outsideReferenceDomain\":%u,\"ssaHardwareRows\":%u,\"maxAbstractWork\":%u,\"maxAbstractSpan\":%u,\"maxArena\":%u,\"linuxBoot\":\"not-tested\"}\n",compared,outside,ssa_rows,max_work,max_span,max_arena);return 0;
}
