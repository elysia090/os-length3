#include "../src/cut-internal.h"
#include "../../x86/check/scalar-plan.h"
#include <quadmath.h>
#include <stdio.h>
#include <xmmintrin.h>
static pl_u8 arena_data[262144],page[4096],module[65536];
static cut_plan prepared_cut;
__extension__ typedef unsigned __int128 uint128;
static __float128 reference(pl_u64 sig,int exponent,pl_u32 sign,pl_u32 cosine)
{
    const uint128 divisor=((uint128)3u<<64u)|0x243f6a8885a308d3ull;
    const __float128 pi=strtoflt128("3.1415926535897932384626433832795028841971693993751",NULL),period=(__float128)divisor*0x1p-64;
    uint128 r=0u,q=0u;__float128 reduced;
    if(exponent>=-1){uint128 n=(uint128)sig<<(unsigned)(exponent+2);q=n/divisor;r=n%divisor;
        int reverse=r>divisor/2u;if(reverse){++q;r=divisor-r;}
        reduced=(__float128)r*0x1p-65;if(reverse)reduced=-reduced;
    }else reduced=(__float128)sig*scalbnq((__float128)1,exponent-63);
    reduced*=pi/period;pl_u32 quadrant=(pl_u32)q&3u,use_cosine=(quadrant&1u)^cosine;
    __float128 value=use_cosine?cosq(reduced):sinq(reduced);pl_u32 negative=(quadrant>>1u)^(cosine?(quadrant&1u):sign);
    return negative?-value:value;
}
static int exponential_check(void)
{
    pl_arena arena={arena_data,196608u,0u};pl_plan p;int status=pl_x86_x87_exponential_value_plan(&arena,&p);
    if(status){printf("exponential plan red %d arena%llu\n",status,(unsigned long long)arena.used);return 1;}
    const __float128 ln2=logq((__float128)2);pl_u64 seed=0x6578705f50616465ull;
    for(pl_u32 row=0u;row<32768u;++row){seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;
        pl_u64 sig=seed|0x8000000000000000ull;int exponent=-(int)(row%141u);if(!exponent)sig=0x8000000000000000ull;
        pl_u32 sign=(row>>7u)&1u;const pl_u64 input[]={sig,(pl_u64)(16383+exponent)|((pl_u64)sign<<15u)};pl_u64 out[3];
        if(check_scalar_projection(&p,input,out,3u))return 1;
        __float128 x=(__float128)sig*scalbnq((__float128)1,exponent-63);if(sign)x=-x;
        __float128 expected=expm1q(x*ln2);double high,low;memcpy(&high,out,8u);memcpy(&low,out+1u,8u);
        int shift=(int)(pl_i64)out[2];__float128 actual=scalbnq((__float128)high+(__float128)low,shift);
        if(fabsq(actual-expected)>fabsq(expected)*(__float128)0x1p-94){char text[160];
            quadmath_snprintf(text,sizeof text,"%.36Qg",actual);printf("exponential numeric red %u actual%s lanes%.17g/%.17g shift%d ",row,text,high,low,shift);
            quadmath_snprintf(text,sizeof text,"%.36Qg",actual-expected);printf("error%s\n",text);return 1;}
    }
    printf("exponential:32768 independent quadmath values, work/span %u/%u arena%llu\n",p.node_count,p.span,(unsigned long long)arena.used);return 0;
}
static int logarithm_check(void)
{
    pl_arena arena={arena_data,196608u,0u};pl_plan p;int status=pl_x86_x87_logarithm_value_plan(&arena,&p);
    if(status){printf("logarithm plan red %d arena%llu\n",status,(unsigned long long)arena.used);return 1;}
    pl_u64 seed=0x6c6f675f63656e74ull;
    for(pl_u32 row=0u;row<32768u;++row){seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;
        pl_u64 sig=seed|0x8000000000000000ull,ysig=sig^0x4217421742174217ull;ysig|=0x8000000000000000ull;
        int exponent=(int)(row%32766u)-16382;pl_u32 sign=(row>>7u)&1u;if(row<16u){sig=row&1u?~0ull:0x8000000000000000ull;exponent=row%4u?0:-1;}
        const pl_u64 input[]={sig,(pl_u64)(16383+exponent),ysig,16383u|((pl_u64)sign<<15u)};pl_u64 out[3];if(check_scalar_projection(&p,input,out,3u))return 1;
        __float128 x=(__float128)sig*0x1p-63,y=(__float128)ysig*0x1p-63;if(sign)y=-y;
        __float128 expected=(log2q(x)+(__float128)exponent)*y;double high,low;memcpy(&high,out,8u);memcpy(&low,out+1u,8u);
        __float128 actual=(__float128)high+(__float128)low;
        // Near one, use log2 of the complete input, never subtract rounded
        // logarithms of two prefixes to construct the independent reference.
        if(exponent==-1&&row<16u)expected=log2q(x/2)*y;
        if(fabsq(actual-expected)>fabsq(expected)*(__float128)0x1p-86){printf("logarithm numeric red %u\n",row);return 1;}
    }
    printf("logarithm:32768 independent quadmath values, work/span %u/%u arena%llu\n",p.node_count,p.span,(unsigned long long)arena.used);return 0;
}
static int logarithm_one_check(void)
{
    pl_arena arena={arena_data,196608u,0u};pl_plan p;int status=pl_x86_x87_logarithm_one_value_plan(&arena,&p);
    if(status){printf("logarithm-one plan red %d arena%llu\n",status,(unsigned long long)arena.used);return 1;}
    pl_u64 seed=0x6c6f6731705f4444ull;const __float128 ln2=logq((__float128)2);
    for(pl_u32 row=0u;row<32768u;++row){seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;
        pl_u64 sig=seed|0x8000000000000000ull,ysig=sig^0x4217421742174217ull;ysig|=0x8000000000000000ull;
        int exponent=-2-(int)(row%141u);if(exponent==-2)sig=0x8000000000000000ull+(sig&0x7fffffffffffffffull)%(0x95f619980c4336f7ull-0x8000000000000000ull+1u);
        pl_u32 sign=(row>>7u)&1u;const pl_u64 input[]={sig,(pl_u64)(16383+exponent)|((pl_u64)sign<<15u),ysig,16383u};pl_u64 out[3];
        if(check_scalar_projection(&p,input,out,3u))return 1;
        __float128 x=(__float128)sig*scalbnq((__float128)1,exponent-63),y=(__float128)ysig*0x1p-63;if(sign)x=-x;
        __float128 expected=log1pq(x)*y/ln2;double high,low;memcpy(&high,out,8u);memcpy(&low,out+1u,8u);
        __float128 actual=scalbnq((__float128)high+(__float128)low,(int)(pl_i64)out[2]);
        if(fabsq(actual-expected)>fabsq(expected)*(__float128)0x1p-86){printf("logarithm-one numeric red %u\n",row);return 1;}
    }
    printf("logarithm-one:32768 independent quadmath values, work/span %u/%u arena%llu\n",p.node_count,p.span,(unsigned long long)arena.used);return 0;
}
static int arctangent_check(void)
{
    static pl_u8 scratch[3][196608];pl_plan plans[3];
    int (*build[])(pl_arena *,pl_plan *)={pl_x86_x87_arctangent_prepare_plan,pl_x86_x87_arctangent_value_plan,pl_x86_x87_arctangent_finish_plan};
    for(pl_u32 n=0u;n<3u;++n){pl_arena arena={scratch[n],sizeof scratch[n],0u};int status=build[n](&arena,plans+n);
        if(status){printf("arctangent plan red %u/%d\n",n,status);return 1;}
        printf("arctangent phase%u work/span %u/%u arena%llu\n",n,plans[n].node_count,plans[n].span,(unsigned long long)arena.used);}
    pl_u64 seed=0x6174616e325f4444ull;const __float128 pi=acosq((__float128)-1);
    for(pl_u32 row=0u;row<32768u;++row){seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;pl_u64 x=seed|0x8000000000000000ull;
        seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;pl_u64 y=seed|0x8000000000000000ull;
        int xe=(int)(row%32766u)-16382,ye=(int)((row*61u)%32766u)-16382;pl_u32 sx=(row>>7u)&1u,sy=(row>>8u)&1u;
        if(row<256u){xe=ye=0;if(row<4u)x=y=0x8000000000000000ull;}
        pl_u64 input[]={x,(pl_u64)(16383+xe)|((pl_u64)sx<<15u),y,(pl_u64)(16383+ye)|((pl_u64)sy<<15u)},prepared[8],angle[2],out[3];
        if(check_scalar_projection(plans,input,prepared,8u)||check_scalar_projection(plans+1,prepared,angle,2u))return 1;
        pl_u64 finish[]={angle[0],angle[1],input[0],input[1],input[2],input[3],prepared[4],prepared[5],(0u-prepared[6])|(prepared[7]<<16u)};
        if(check_scalar_projection(plans+2,finish,out,3u))return 1;
        int bigger=ye>xe||(ye==xe&&y>x),distance=bigger?ye-xe:xe-ye;
        __float128 ratio=bigger?(__float128)x/(__float128)y:(__float128)y/(__float128)x,expected;
        if(distance>110&&!bigger&&!sx){expected=ratio;if(sy)expected=-expected;
            if((pl_i64)out[2]!=-distance)return 1;
        }else{ratio=scalbnq(ratio,distance>200?-200:-distance);expected=atanq(ratio);if(bigger)expected=pi/2-expected;if(sx)expected=pi-expected;if(sy)expected=-expected;
            if(out[2])return 1;}
        double high,low;memcpy(&high,out,8u);memcpy(&low,out+1u,8u);__float128 actual=(__float128)high+(__float128)low;
        if(fabsq(actual-expected)>(__float128)0x1p-86){printf("arctangent numeric red %u\n",row);return 1;}
    }
    puts("arctangent:32768 independent scaled quadmath values, both quadrant/signs and unrestricted exponent distances");return 0;
}
static int references(const char *directory,const char *mode)
{
    char base[32];if(strlen(mode)>=sizeof base)return 2;strcpy(base,mode);char *suffix=strstr(base,"-underflow");
    int underflow=suffix!=NULL;if(suffix){if(strcmp(suffix,"-underflow"))return 2;*suffix=0;}
    pl_u32 cosine=!strcmp(base,"--cos"),push=!strcmp(base,"--sincos")||!strcmp(base,"--tan"),tangent=!strcmp(base,"--tan");
    if(!cosine&&!push&&strcmp(base,"--sin"))return 2;
    const char *prefix=mode+2;static machine_state states[96][2];static pl_u64 values[96][2][3];pl_u32 generated=0u;
    for(pl_u32 form=0u;form<(underflow?128u:448u);++form){char name[4096];int n=snprintf(name,sizeof name,"%s/x87-%s-%u.cases",directory,prefix,form);
        if(n<1||(size_t)n>=sizeof name)return 1;
        FILE *f=fopen(name,"rb");if(!f)return 1;int bad=fread(states,1u,sizeof states,f)!=sizeof states;if(fclose(f))bad=1;if(bad)return 1;
        memset(values,0,sizeof values);
        for(pl_u32 row=0u;row<96u;++row){const machine_state *a=states[row];pl_u32 top=(a->x87_status>>11u)&7u,next=(top+7u)&7u;
            pl_u64 sig=a->x87_significand[top];pl_u32 se=a->x87_sign_exponent[top],exp=se&32767u;
            if(exp<16351u||exp>=16446u||!(sig>>63u)||((a->x87_tag>>(top*2u))&3u)==3u||(push&&((a->x87_tag>>(next*2u))&3u)!=3u))continue;
            for(pl_u32 output=0u;output<(!tangent&&push?2u:1u);++output){
                __float128 value=reference(sig,(int)exp-16383,se>>15u,push?output:cosine);
                if(tangent)value/=reference(sig,(int)exp-16383,se>>15u,1u);
                pl_u32 sign=value<0;int exponent=0;__float128 magnitude=frexpq(fabsq(value),&exponent);
                __float128 scaled=scalbnq(magnitude,64);pl_u64 significand=(pl_u64)scaled;
                values[row][output][0]=significand;values[row][output][1]=(pl_u64)scalbnq(scaled-(__float128)significand,64);
                values[row][output][2]=(pl_u64)(exponent-1+16383)|((pl_u64)sign<<15u);++generated;
            }
        }
        n=snprintf(name,sizeof name,"%s/x87-%s-%u.reference",directory,prefix,form);if(n<1||(size_t)n>=sizeof name)return 1;
        f=fopen(name,"wbx");if(!f)return 1;bad=fwrite(values,1u,sizeof values,f)!=sizeof values;if(fclose(f))bad=1;if(bad)return 1;
    }
    printf("trig reference: %u independent quadmath results; 64-bit integer plus 64-bit residual, PC ignored\n",generated);return 0;
}
static int logarithm_references(const char *directory,pl_u32 plus_one)
{
    static machine_state states[1024][2];static pl_u64 values[1024][4];pl_u32 generated=0u;
    const __float128 threshold=sqrtq((__float128)2);
    for(pl_u32 form=0u;form<224u;++form){char name[4096];int n=snprintf(name,sizeof name,"%s/x87-binary-special-%u.cases",directory,form);
        if(n<1||(size_t)n>=sizeof name)return 1;
        FILE *f=fopen(name,"rb");if(!f)return 1;int bad=fread(states,1u,sizeof states,f)!=sizeof states;if(fclose(f))bad=1;if(bad)return 1;
        memset(values,0,sizeof values);
        for(pl_u32 row=0u;row<1024u;++row){const machine_state *a=states[row];pl_u32 x=(a->x87_status>>11u)&7u,y=(x+1u)&7u;
            pl_u64 xs=a->x87_significand[x],ys=a->x87_significand[y];pl_u32 xe=a->x87_sign_exponent[x],ye=a->x87_sign_exponent[y];
            if((!plus_one&&(xe&32768u))||(xe&32767u)==32767u||(ye&32767u)==32767u||!xs||!ys
                ||((xe&32767u)&&!(xs>>63u))||((ye&32767u)&&!(ys>>63u))
                ||((a->x87_tag>>(x*2u))&3u)==3u||((a->x87_tag>>(y*2u))&3u)==3u
                ||(!plus_one&&xs==0x8000000000000000ull&&(xe&32767u)==16383u))continue;
            if(plus_one&&((xe&32767u)>16381u||((xe&32767u)==16381u&&xs>0x95f619980c4336f7ull)))continue;
            // Unmasked input denormal stops before either numeric write/pop.
            if(!(a->x87_control&2u)&&(!(xe&32767u)||!(ye&32767u)))continue;
            int x_exp=(int)((xe&32767u)?xe&32767u:1u)-16383,y_exp=(int)((ye&32767u)?ye&32767u:1u)-16383;
            __float128 m=(__float128)xs*0x1p-63,value;
            if(plus_one){if(xe&32768u)m=-m;
                if(x_exp<-110){value=m/logq((__float128)2);y_exp+=x_exp;}
                else value=log1pq(scalbnq(m,x_exp))/logq((__float128)2);
                value*=((__float128)ys*0x1p-63);
            }else{if(m>=threshold){m/=2;++x_exp;}value=(log2q(m)+(__float128)x_exp)*((__float128)ys*0x1p-63);}
            if(ye&32768u)value=-value;
            pl_u32 sign=value<0;int exponent=0;__float128 magnitude=frexpq(fabsq(value),&exponent),scaled=scalbnq(magnitude,64);
            pl_u64 sig=(pl_u64)scaled;values[row][0]=sig;values[row][1]=(pl_u64)scalbnq(scaled-(__float128)sig,64);
            values[row][2]=(pl_u64)(pl_i64)(exponent-1+y_exp+16383);values[row][3]=sign;++generated;
        }
        n=snprintf(name,sizeof name,"%s/x87-binary-special-%u.reference",directory,form);if(n<1||(size_t)n>=sizeof name)return 1;
        f=fopen(name,"wbx");if(!f)return 1;bad=fwrite(values,1u,sizeof values,f)!=sizeof values;if(fclose(f))bad=1;if(bad)return 1;
    }
    printf("logarithm reference: %u independent fp128 significand/residual/exponent/sign records\n",generated);return 0;
}
static int angle_references(const char *directory)
{
    static machine_state states[1024][2];static pl_u64 values[1024][4];pl_u32 generated=0u;const __float128 pi=acosq((__float128)-1);
    for(pl_u32 form=0u;form<224u;++form){char name[4096];int n=snprintf(name,sizeof name,"%s/x87-binary-special-%u.cases",directory,form);
        if(n<1||(size_t)n>=sizeof name)return 1;
        FILE *f=fopen(name,"rb");if(!f)return 1;int bad=fread(states,1u,sizeof states,f)!=sizeof states;if(fclose(f))bad=1;if(bad)return 1;
        memset(values,0,sizeof values);
        for(pl_u32 row=0u;row<1024u;++row){const machine_state *a=states[row];pl_u32 x=(a->x87_status>>11u)&7u,y=(x+1u)&7u;
            pl_u64 xs=a->x87_significand[x],ys=a->x87_significand[y];pl_u32 xe=a->x87_sign_exponent[x],ye=a->x87_sign_exponent[y],ex=xe&32767u,ey=ye&32767u;
            if(((ex&&!(xs>>63u))||(ey&&!(ys>>63u)))||(ex==32767u&&(xs&0x7fffffffffffffffull))||(ey==32767u&&(ys&0x7fffffffffffffffull))
                ||((a->x87_tag>>(x*2u))&3u)==3u||((a->x87_tag>>(y*2u))&3u)==3u)continue;
            if(!(a->x87_control&2u)&&((!ex&&xs)||(!ey&&ys)))continue;
            int xinf=ex==32767u,yinf=ey==32767u,xzero=!ex&&!xs,yzero=!ey&&!ys,xsign=(xe>>15u)!=0;
            __float128 value;int extra=0;
            if(yzero||(xinf&&!yinf))value=xsign?pi:0;
            else if((yinf&&!xinf)||xzero)value=pi/2;
            else if(xinf&&yinf)value=xsign?3*pi/4:pi/4;
            else{unsigned xl=(unsigned)__builtin_clzll(xs),yl=(unsigned)__builtin_clzll(ys);xs<<=xl;ys<<=yl;
                int xexp=(int)(ex?ex:1u)-(int)xl,yexp=(int)(ey?ey:1u)-(int)yl;
                int bigger=yexp>xexp||(yexp==xexp&&ys>xs),distance=bigger?yexp-xexp:xexp-yexp;
                __float128 ratio=bigger?(__float128)xs/(__float128)ys:(__float128)ys/(__float128)xs;
                if(distance>110&&!bigger&&!xsign){value=ratio;extra=-distance;}
                else{value=atanq(scalbnq(ratio,distance>200?-200:-distance));if(bigger)value=pi/2-value;if(xsign)value=pi-value;}
            }
            if(ye&32768u)value=-value;
            if(value==0)continue;
            int exponent=0;__float128 magnitude=frexpq(fabsq(value),&exponent),scaled=scalbnq(magnitude,64);pl_u64 sig=(pl_u64)scaled;
            values[row][0]=sig;values[row][1]=(pl_u64)scalbnq(scaled-(__float128)sig,64);values[row][2]=(pl_u64)(pl_i64)(exponent-1+extra+16383);values[row][3]=value<0;++generated;
        }
        n=snprintf(name,sizeof name,"%s/x87-binary-special-%u.reference",directory,form);if(n<1||(size_t)n>=sizeof name)return 1;
        f=fopen(name,"wbx");if(!f)return 1;bad=fwrite(values,1u,sizeof values,f)!=sizeof values;if(fclose(f))bad=1;if(bad)return 1;
    }
    printf("angle reference: %u independent fp128 significand/residual/exponent/sign records\n",generated);return 0;
}
int main(int argc,char **argv)
{
    if(argc==3&&!strcmp(argv[1],"--log-reference"))return logarithm_references(argv[2],0u);
    if(argc==3&&!strcmp(argv[1],"--log-one-reference"))return logarithm_references(argv[2],1u);
    if(argc==3&&!strcmp(argv[1],"--angle-reference"))return angle_references(argv[2]);
    if(argc==4&&!strcmp(argv[1],"--reference"))return references(argv[2],argv[3]);
    if(argc!=1)return 2;
    unsigned saved=_mm_getcsr();_mm_setcsr(0x1f80u);pl_u64 seed=0x747269675f64645full;pl_u32 comparisons=0u;
    for(pl_u32 cosine=0u;cosine<2u;++cosine){pl_arena arena={arena_data,196608u,0u};pl_plan p;
        int status=pl_x86_x87_trig_value_plan(cosine,&arena,&p);
        if(status){printf("trig plan red %d arena%llu\n",status,(unsigned long long)arena.used);return 1;}
        {wasm_writer writer={.capacity=sizeof module};cut_lowering c={.writer=&writer};
            const pl_u32 input[]={1u,2u},output[]={3u,4u};cut_emit_scalar_projection(&c,&p,input,20u,output,2u);
            if(writer.error){printf("trig pure emitter red %d\n",writer.error);return 1;}}
        for(pl_u32 row=0u;row<32768u;++row){seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;pl_u64 sig=seed|0x8000000000000000ull;
            int exponent=(int)(row%80u)-17;pl_u32 sign=(row>>7u)&1u;pl_u64 input[]={sig,(pl_u64)(16383+exponent)|((pl_u64)sign<<15u)},out[2];
            if(check_scalar_projection(&p,input,out,2u))return 1;
            __float128 expected=reference(sig,exponent,sign,cosine);
            double high,low;memcpy(&high,out,8u);memcpy(&low,out+1u,8u);
            __float128 actual=(__float128)high+(__float128)low,error=fabsq(actual-expected);
            if(error>(__float128)0x1p-94){char formatted[96];quadmath_snprintf(formatted,sizeof formatted,"%.36Qg",error);
                printf("trig numeric red %u/%u e%d error%s\n",cosine,row,exponent,formatted);return 1;}++comparisons;
        }
        printf("trig %s work/span %u/%u arena%llu\n",cosine?"cos":"sin",p.node_count,p.span,(unsigned long long)arena.used);
        arena.used=0u;status=pl_x86_compensated_round_plan(&arena,&p);
        if(status){printf("compensated round plan red %d\n",status);return 1;}
        arena.used=0u;status=pl_x86_x87_trig_result_plan(cosine,&arena,&p);
        if(status){printf("trig publication plan red %d\n",status);return 1;}
        memset(page,0x90,sizeof page);page[0]=0xd9u;page[1]=(pl_u8)(cosine?0xffu:0xfeu);
        pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
        pl_x86_instruction instruction;status=pl_x86_decode_profile(&image,map.address,&instruction);
        if(status||!pl_x86_x87_trig_supported(&instruction)){printf("trig decode red %d argument%llx\n",status,(unsigned long long)instruction.machine_argument);return 1;}
        wasm_cut_options options={map.address,1u,sizeof module};pl_u64 written=0u;wasm_cut_report report;
        status=cut_prepare_image(&image,&options,&prepared_cut);if(status){printf("trig prepare red %d\n",status);return 1;}
        wasm_writer measure={.capacity=sizeof module};pl_u32 imports=0u;
        status=cut_measure_body(&measure,&prepared_cut,&report,&imports);
        if(status){printf("trig body red %d writer%d bytes%llu imports%x\n",status,measure.error,(unsigned long long)measure.used,imports);return 1;}
        status=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&written,&report);
        if(status){printf("trig emitted cut red %d\n",status);return 1;}
        printf("trig emitted %llu bytes\n",(unsigned long long)written);
    }
    if(exponential_check())return 1;
    if(logarithm_check())return 1;
    if(logarithm_one_check())return 1;
    if(arctangent_check())return 1;
    _mm_setcsr(saved);printf("trig: %u independent quadmath finite comparisons; architectural state checked separately\n",comparisons);return 0;
}
