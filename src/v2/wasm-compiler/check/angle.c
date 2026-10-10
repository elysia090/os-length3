#include "../src/cut-internal.h"
#include "../../x86/src/angle.h"
#include "../../x86/check/scalar-plan.h"
#include <stdio.h>
#include <xmmintrin.h>
static pl_u8 arena_data[65536],body[32768],module[65536];
static int plan(pl_arena *arena,pl_plan *out)
{
    pl_plan raw={.instructions=1u};expression e={0};
    if(pl_builder_open(&e.builder,&raw,arena,256u,768u,0u,6u))return PL_ERROR_ARENA;
    reduced_angle r=reduce_angle(&e,(pl_operand){PL_OPERAND_LOCAL,0u},(pl_operand){PL_OPERAND_LOCAL,1u});
    raw.locals[0]=r.quadrant;raw.locals[1]=r.magnitude_high;raw.locals[2]=r.magnitude_low;
    raw.locals[3]=r.negative;raw.locals[4]=r.value.high;raw.locals[5]=r.value.low;
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u,1u,1u,1u};return pl_compact_projected(&raw,live,arena,out);
}
static int emit(const char *directory,const pl_plan *p)
{
    wasm_writer w={.bytes=body,.capacity=sizeof body};cut_lowering c={.writer=&w};
    wasm_writer_uleb(&w,1u);wasm_writer_uleb(&w,p->node_count+24u);wasm_writer_byte(&w,0x7eu);
    cut_op(&c,0x20u);wasm_writer_uleb(&w,0u);cut_set(&c,1u);cut_op(&c,0x20u);wasm_writer_uleb(&w,1u);cut_set(&c,2u);
    const pl_u32 input[]={1u,2u,0u,0u,0u,0u},output[]={3u,4u,5u,6u,7u,8u};
    cut_emit_scalar_projection(&c,p,input,20u,output,6u);
    for(pl_u32 n=0u;n<6u;++n)cut_get(&c,output[n]);
    cut_op(&c,0x0bu);if(w.error)return 1;
    wasm_writer m={.bytes=module,.capacity=sizeof module};
    const pl_u8 header[]={0,97,115,109,1,0,0,0,1,12,1,0x60,2,0x7e,0x7e,6,0x7e,0x7e,0x7e,0x7e,0x7e,0x7e,
        3,2,1,0,7,11,1,7,'c','o','m','p','u','t','e',0,0};
    for(pl_u32 n=0u;n<sizeof header;++n)wasm_writer_byte(&m,header[n]);
    pl_u32 count=1u;for(pl_u64 n=w.used;n>=128u;n>>=7u)++count;
    wasm_writer_byte(&m,10u);wasm_writer_uleb(&m,1u+count+w.used);wasm_writer_uleb(&m,1u);wasm_writer_uleb(&m,w.used);
    for(pl_u64 n=0u;n<w.used;++n)wasm_writer_byte(&m,body[n]);
    if(m.error)return 1;
    char name[4096];int n=snprintf(name,sizeof name,"%s/angle.wasm",directory);if(n<1||(size_t)n>=sizeof name)return 1;
    FILE *f=fopen(name,"wbx");if(!f)return 1;int bad=fwrite(module,1u,(size_t)m.used,f)!=m.used;if(fclose(f))bad=1;return bad;
}
int main(int argc,char **argv)
{
    if(argc!=1&&argc!=2)return 2;
    unsigned saved=_mm_getcsr();_mm_setcsr(0x1f80u);pl_arena arena={arena_data,sizeof arena_data,0u};pl_plan p;
    if(plan(&arena,&p))return 1;
    __extension__ typedef unsigned __int128 uint128;
    const uint128 divisor=((uint128)3u<<64u)|0x243f6a8885a308d3ull;
    pl_u64 seed=0x5150495f736c6963ull;pl_u32 comparisons=0u;
    for(pl_u32 exponent=0u;exponent<64u;++exponent)for(pl_u32 row=0u;row<2048u;++row){
        seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;pl_u64 sig=seed|0x8000000000000000ull;
        if(row<4u)sig=row&1u?~0ull:0x8000000000000000ull;
        const pl_u64 input[]={sig,(pl_u64)exponent-1u,0u,0u,0u,0u};pl_u64 out[6];
        if(check_scalar_projection(&p,input,out,6u))return 1;
        uint128 numerator=(uint128)sig<<(exponent+1u),q=numerator/divisor,r=numerator%divisor;
        pl_u64 reverse=r>divisor/2u;if(reverse){++q;r=divisor-r;}
        if(out[0]!=((pl_u64)q&3u)||out[1]!=(pl_u64)(r>>64u)||out[2]!=(pl_u64)r||out[3]!=reverse){
            printf("angle residual red exponent%u row%u\n",exponent,row);return 1;}
        double high,low;memcpy(&high,out+4u,8u);memcpy(&low,out+5u,8u);
        __float128 reference=(__float128)r*0x1p-65;if(reverse)reference=-reference;
        if((__float128)high+(__float128)low!=reference){printf("angle lanes red exponent%u row%u\n",exponent,row);return 1;}
        ++comparisons;
    }
    if(argc==2&&emit(argv[1],&p))return 1;
    _mm_setcsr(saved);printf("angle: %u exact integer/fp128 reductions; work/span %u/%u; Wasm tested separately\n",comparisons,p.node_count,p.span);return 0;
}
