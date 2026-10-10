#include "x87-hardware.h"
#include <stdio.h>
#ifdef _WIN32
static machine_state records[96][2];
static const char *record_prefix="x87-round";
typedef struct {pl_u64 sig;pl_u16 se;} raw;
static void put(pl_u8 *p,pl_u64 x,unsigned n){for(unsigned i=0u;i<n;++i)p[i]=(pl_u8)(x>>(8u*i));}
static int save(const char *dir,unsigned form,const char *suffix,const void *data,size_t n)
{char path[4096];int m=snprintf(path,sizeof path,"%s/%s-%u.%s",dir,record_prefix,form,suffix);if(m<1||(size_t)m>=sizeof path)return 1;
 FILE *file=fopen(path,"wbx");if(!file)return 1;int bad=fwrite(data,1u,n,file)!=n;if(fclose(file))bad=1;return bad;}
#endif
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    char mode[40]={0};int underflow=0;
    if(argc==3){if(strlen(argv[2])>=sizeof mode)return 2;strcpy(mode,argv[2]);char *suffix=strstr(mode,"-underflow");
        if(suffix){if(strcmp(suffix,"-underflow"))return 2;*suffix=0;underflow=1;}}
    int root=argc==3&&!strcmp(mode,"--root"),extract=argc==3&&!strcmp(mode,"--extract");
    int exponential=argc==3&&!strcmp(mode,"--exponential");
    int trig=argc==3?(!strcmp(mode,"--cos")?0:!strcmp(mode,"--sin")?1:!strcmp(mode,"--sincos")?2:!strcmp(mode,"--tan")?3:-1):-1;
    if(underflow&&!exponential&&trig<0)return 2;
    if(argc!=2&&!root&&!extract&&!exponential&&trig<0)return 2;
    if(root)record_prefix="x87-root";
    if(extract)record_prefix="x87-extract";
    if(exponential)record_prefix="x87-exponential";
    if(trig>=0)record_prefix=trig==0?"x87-cos":trig==1?"x87-sin":trig==2?"x87-sincos":"x87-tan";
    char underflow_name[64];if(underflow){int n=snprintf(underflow_name,sizeof underflow_name,"%s-underflow",record_prefix);
        if(n<1||(size_t)n>=sizeof underflow_name)return 1;
        record_prefix=underflow_name;}
    pl_u8 *code=check_x87_allocate(4096u);if(!code)return 1;pl_u64 seed=0x71fa903abc4856deull;
    const raw values[]={{0u,0u},{0x8000000000000000ull,0x3ffeu},{0xc000000000000000ull,0x3fffu},{0xa000000000000000ull,0x4000u},
        {1u,0u},{0x8000000000000000ull,0u},{0x8000000000000000ull,0x7fffu},{0xc000000000000001ull,0x7fffu},{0x8000000000000001ull,0x7fffu},
        {1u,1u},{~0ull,0x403du},{0x8000000000000000ull,0x403eu},{~0ull,0x7ffeu},{~0ull,0x3ffdu},{0x8000000000000000ull,1u},{0x8000000000000000ull,0x3fffu}};
    const pl_u8 prefixes[]={0u,0x66u,0x67u,0x48u};unsigned form=0u;
    for(unsigned prefix=0u;prefix<4u;++prefix)for(unsigned pc=0u;pc<4u;++pc)for(unsigned rc=0u;rc<4u;++rc)for(unsigned mask=underflow?7u:0u;mask<(underflow?9u:extract||exponential||trig>=0?7u:5u);++mask,++form){unsigned n=0u;DWORD old;
        if(!VirtualProtect(code,4096u,PAGE_READWRITE,&old))return 1;
        if(prefixes[prefix])code[n++]=prefixes[prefix];
        code[n++]=0xd9u;code[n++]=(pl_u8)(exponential?0xf0u:trig>=0?(trig==0?0xffu:trig==1?0xfeu:trig==2?0xfbu:0xf2u):extract?0xf4u:root?0xfau:0xfcu);code[n]=0xc3u;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&old)||!FlushInstructionCache(GetCurrentProcess(),code,n+1u))return 1;
        for(unsigned row=0u;row<96u;++row){unsigned top=row&7u;_Alignas(16) pl_u8 input[512]={0},before[512],after[512];pl_u16 tags[2];
            unsigned clear=mask==1u?1u:mask==2u?2u:mask==3u?32u:mask==4u?35u:mask==5u?4u:mask==6u?7u:mask==7u?16u:mask==8u?48u:0u;
            put(input,(0x7fu|(pc<<8u)|(rc<<10u))&~clear,2u);put(input+2u,0x4700u|(top<<11u),2u);input[4]=(pl_u8)(row>=64u&&row<72u?255u&~(1u<<top):255u);
            if((extract||trig>=2)&&row<80u)input[4]=(pl_u8)(input[4]&~(1u<<((top+7u)&7u)));
            put(input+6u,0x123u,2u);put(input+8u,0x12340000u,8u);put(input+16u,0x56780000u,8u);put(input+24u,0x1f80u,4u);
            for(unsigned rank=0u;rank<8u;++rank){put(input+32u+rank*16u,0x8000000000000000ull+rank,8u);put(input+40u+rank*16u,0x3fffu,2u);}
            seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;raw value=row<64u?values[(row/2u)%16u]:(raw){seed,(pl_u16)(16370u+row%100u)};
            value.se=(pl_u16)(value.se|(row&1u?32768u:0u));put(input+32u,value.sig,8u);put(input+40u,value.se,2u);
            machine_state *a=records[row],*b=a+1u;memset(a,0,sizeof *a);for(unsigned rank=0u;rank<16u;++rank)a->registers[rank]=0xabcdef0123450000ull+rank;
            a->rip=0x400000u;a->rflags=0xa92u;a->cr0=0x80010031u;a->cr3=0x1000u;a->cr4=32u;a->efer=0xd00u;
            a->system[MACHINE_SYSTEM_CS]=19u;a->system[MACHINE_SYSTEM_DR0+7u]=0x400u;a->retired=42u;*b=*a;
            check_x87_hardware_full(a,b,code,input,before,after,tags);check_x87_project(a,before);check_x87_project(b,after);a->x87_tag=tags[0];b->x87_tag=tags[1];
            if(b->x87_ip==(pl_u64)(uintptr_t)code)b->x87_ip=a->rip;
            b->rip+=n;++b->retired;
        }
        char json[128];int m=snprintf(json,sizeof json,"{\"sourceBytes\":%u,\"stateBytes\":1256,\"native\":96,\"bytes\":0}\n",n);
        if(m<1||(size_t)m>=sizeof json||save(argv[1],form,"json",json,(size_t)m)||save(argv[1],form,"source",code,n)||save(argv[1],form,"cases",records,sizeof records))return 1;
    }
    if(!VirtualFree(code,0u,MEM_RELEASE))return 1;
    printf("%s: %u complete physical states, PC/RC/exception masks/prefix, signed ties, empty/NaN/pseudo and exponent edges\n",record_prefix,form*96u);return 0;
#endif
}
