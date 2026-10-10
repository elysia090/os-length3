#include "../src/cut-internal.h"
#include "../../x86/src/compensated.h"
#include "../../x86/check/scalar-plan.h"
#include <stdio.h>
#include <xmmintrin.h>
static pl_u8 arena_data[131072],body[16384],module[32768];
static int plan(pl_u32 operation,pl_arena *arena,pl_plan *out)
{
    pl_plan raw={.instructions=1u};expression e={0};if(pl_builder_open(&e.builder,&raw,arena,128u,384u,0u,2u))return PL_ERROR_ARENA;
    compensated a=compensated_significand(&e,(pl_operand){PL_OPERAND_LOCAL,0u}),b=compensated_significand(&e,(pl_operand){PL_OPERAND_LOCAL,1u}),r;
    r=operation==0u?compensated_add(&e,a,b):operation==1u?compensated_multiply(&e,a,b):compensated_divide(&e,a,b);
    raw.locals[0]=r.high;raw.locals[1]=r.low;if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u};return pl_compact_projected(&raw,live,arena,out);
}
static int emit(const char *dir,pl_u32 operation,const pl_plan *p)
{
    wasm_writer w={.bytes=body,.capacity=sizeof body};cut_lowering c={.writer=&w};
    wasm_writer_uleb(&w,1u);wasm_writer_uleb(&w,p->node_count+20u);wasm_writer_byte(&w,0x7eu);
    cut_op(&c,0x20u);wasm_writer_uleb(&w,0u);cut_set(&c,1u);cut_op(&c,0x20u);wasm_writer_uleb(&w,1u);cut_set(&c,2u);
    const pl_u32 input[]={1u,2u},output[]={3u,4u};cut_emit_scalar_projection(&c,p,input,10u,output,2u);
    cut_get(&c,3u);cut_get(&c,4u);cut_op(&c,0x0bu);if(w.error)return 1;
    wasm_writer m={.bytes=module,.capacity=sizeof module};
    const pl_u8 header[]={0,97,115,109,1,0,0,0,1,8,1,0x60,2,0x7e,0x7e,2,0x7e,0x7e,3,2,1,0,7,11,1,7,'c','o','m','p','u','t','e',0,0};
    for(pl_u32 n=0u;n<sizeof header;++n)wasm_writer_byte(&m,header[n]);
    pl_u32 count=1u;for(pl_u64 n=w.used;n>=128u;n>>=7u)++count;
    wasm_writer_byte(&m,10u);wasm_writer_uleb(&m,1u+count+w.used);wasm_writer_uleb(&m,1u);wasm_writer_uleb(&m,w.used);
    for(pl_u64 n=0u;n<w.used;++n)wasm_writer_byte(&m,body[n]);
    if(m.error)return 1;
    char path[4096];int n=snprintf(path,sizeof path,"%s/compensated-%u.wasm",dir,operation);if(n<1||(size_t)n>=sizeof path)return 1;
    FILE *f=fopen(path,"wbx");if(!f)return 1;int bad=fwrite(module,1u,(size_t)m.used,f)!=m.used;if(fclose(f))bad=1;return bad;
}
static int round_check(void)
{
    pl_arena arena={arena_data,sizeof arena_data,0u};pl_plan p;if(pl_x86_compensated_round_plan(&arena,&p))return 1;
    pl_u64 seed=0x726f756e645f4444ull;pl_u32 comparisons=0u;
    for(pl_u32 row=0u;row<16384u;++row){seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;
        pl_u64 high=0x3ff0000000000000ull|(seed&0x000fffffffffffffull);
        seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;pl_u64 low=0x3c70000000000000ull|(seed&0x000fffffffffffffull);
        if(row&1u)low|=0x8000000000000000ull;
        if(row<8u){high=0x3ff0000000000000ull;low=row&1u?0u:0x3be0000000000000ull;}
        double a,b;memcpy(&a,&high,8u);memcpy(&b,&low,8u);__float128 value=(__float128)a+(__float128)b;
        pl_u64 exponent=16383u;if(value<1){value*=2;--exponent;}if(value>=2){value/=2;++exponent;}
        __float128 scaled=value*0x1p63;pl_u64 base=(pl_u64)scaled;__float128 remainder=scaled-(__float128)base;
        for(pl_u32 sign=0u;sign<2u;++sign)for(pl_u32 rc=0u;rc<4u;++rc){pl_u64 sign_mask=(pl_u64)sign<<63u;
            pl_u64 input[]={high^sign_mask,low^sign_mask,0u,0x7fu|((pl_u64)(row&3u)<<8u)|((pl_u64)rc<<10u),0u},out[3];
            if(check_scalar_projection(&p,input,out,3u))return 1;
            pl_u64 increment=rc==0u?(remainder>(__float128)0.5||(remainder==(__float128)0.5&&(base&1u))):
                remainder!=0&&((rc==1u&&sign)||(rc==2u&&!sign));
            pl_u64 sig=base+increment,exp=exponent;if(!sig){sig=0x8000000000000000ull;++exp;}
            pl_u64 se=exp|((pl_u64)sign<<15u),raised=(remainder!=0?32u:0u)|(increment<<9u);
            if(out[0]!=sig||out[1]!=se||out[2]!=raised){printf("compensated round red %u/%u/%u\n",row,sign,rc);return 1;}++comparisons;
        }
    }
    printf("compensated round: %u independent fp128 exact-significand/C1/PE/PC/RC comparisons\n",comparisons);return 0;
}
int main(int argc,char **argv)
{
    if(argc!=1&&argc!=2)return 2;
    unsigned saved=_mm_getcsr();_mm_setcsr(0x1f80u);pl_u64 seed=0x639721abde5430ffull;pl_u32 comparisons=0u;
    for(pl_u32 operation=0u;operation<3u;++operation){pl_arena arena={arena_data,sizeof arena_data,0u};pl_plan p;
        int status=plan(operation,&arena,&p);if(status){printf("compensated plan%d\n",status);return 1;}
        for(pl_u32 row=0u;row<16384u;++row){seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;pl_u64 a=seed|0x8000000000000000ull;
            seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;pl_u64 b=seed|0x8000000000000000ull;
            if(row<4u){a=row&1u?~0ull:0x8000000000000000ull;b=row&2u?~0ull:0x8000000000000000ull;}
            const pl_u64 input[]={a,b};pl_u64 out[2];if(check_scalar_projection(&p,input,out,2u))return 1;
            double high,low;memcpy(&high,out,8u);memcpy(&low,out+1u,8u);
            __float128 x=(__float128)a*0x1p-63,y=(__float128)b*0x1p-63,reference=operation==0u?x+y:operation==1u?x*y:x/y;
            __float128 actual=(__float128)high+(__float128)low,error=actual-reference;if(error<0)error=-error;
            if(error>(__float128)0x1p-99){printf("compensated red operation%u row%u\n",operation,row);return 1;}++comparisons;
        }
        if(argc==2&&emit(argv[1],operation,&p))return 1;
        printf("compensated operation%u work/span %u/%u\n",operation,p.node_count,p.span);
    }
    if(round_check())return 1;
    _mm_setcsr(saved);printf("compensated: %u independent fp128 residual comparisons; emitted Wasm tested separately\n",comparisons);return 0;
}
