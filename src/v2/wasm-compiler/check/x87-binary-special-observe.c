#include "x87-hardware.h"
#include <stdio.h>
#ifdef _WIN32
enum { ROWS=1024 };
static machine_state records[ROWS][2];
typedef struct {pl_u64 sig;pl_u16 se;} raw;
static void put(pl_u8 *p,pl_u64 value,pl_u32 n){for(pl_u32 b=0u;b<n;++b)p[b]=(pl_u8)(value>>(b*8u));}
static int save(const char *dir,pl_u32 form,const char *suffix,const void *data,size_t n)
{
    char path[4096];int count=snprintf(path,sizeof path,"%s/x87-binary-special-%u.%s",dir,form,suffix);
    if(count<1||(size_t)count>=sizeof path)return 1;
    FILE *f=fopen(path,"wbx");if(!f)return 1;int bad=fwrite(data,1u,n,f)!=n;if(fclose(f))bad=1;return bad;
}
#endif
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    if(argc!=3)return 2;
    pl_u32 operation=!strcmp(argv[2],"--scale")?0u:!strcmp(argv[2],"--remainder")?1u:!strcmp(argv[2],"--nearest-remainder")?2u:
        !strcmp(argv[2],"--logarithm")?3u:!strcmp(argv[2],"--logarithm-one")?4u:!strcmp(argv[2],"--arctangent")?5u:6u;
    if(operation>5u)return 2;
    pl_u8 *code=check_x87_allocate(4096u);if(!code)return 1;
    const raw values[]={{0u,0u},{1u,0u},{0x8000000000000000ull,0u},{0x8000000000000000ull,1u},
        {0x8000000000000000ull,0x3ffeu},{0x8000000000000000ull,0x3fffu},{0xa000000000000000ull,0x4001u},
        {~0ull,0x403fu},{~0ull,0x405fu},{0x8000000000000000ull,0x400fu},{~0ull,0x7ffeu},
        {0x8000000000000000ull,0x7fffu},{0xc000000000000001ull,0x7fffu},{0x8000000000000001ull,0x7fffu},
        {1u,1u},{1u,0x7fffu}};
    pl_u32 form=0u;
    for(pl_u32 prefix=0u;prefix<2u;++prefix)for(pl_u32 pc=0u;pc<4u;++pc)for(pl_u32 rc=0u;rc<4u;++rc)
    for(pl_u32 mask=0u;mask<7u;++mask,++form){pl_u32 n=0u;DWORD old;
        if(!VirtualProtect(code,4096u,PAGE_READWRITE,&old))return 1;
        if(prefix)code[n++]=0x66u;
        const pl_u8 opcodes[]={0xfdu,0xf8u,0xf5u,0xf1u,0xf9u,0xf3u};code[n++]=0xd9u;code[n++]=opcodes[operation];code[n]=0xc3u;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&old)||!FlushInstructionCache(GetCurrentProcess(),code,n+1u))return 1;
        for(pl_u32 row=0u;row<ROWS;++row){pl_u32 top=row&7u;_Alignas(16) pl_u8 input[512]={0},before[512],after[512];pl_u16 tags[2];
            pl_u32 clear=mask==1u?1u:mask==2u?2u:mask==3u?8u:mask==4u?16u:mask==5u?32u:mask==6u?59u:0u;
            put(input,(0x7fu|(pc<<8u)|(rc<<10u))&~clear,2u);put(input+2u,0x4700u|(top<<11u),2u);input[4]=255u;
            if(row>=960u&&row<992u)input[4]=(pl_u8)(255u&~(1u<<top));
            else if(row>=992u)input[4]=(pl_u8)(255u&~(1u<<((top+1u)&7u)));
            put(input+6u,0x123u,2u);put(input+8u,0x12340000u,8u);put(input+16u,0x56780000u,8u);put(input+24u,0x1f80u,4u);
            for(pl_u32 r=0u;r<8u;++r){put(input+32u+r*16u,0x8000000000000000ull+r,8u);put(input+40u+r*16u,0x3fffu,2u);}
            raw a=values[(row>>4u)&15u],b=values[row&15u];a.se=(pl_u16)(a.se|((row&256u)?32768u:0u));b.se=(pl_u16)(b.se|((row&512u)?32768u:0u));
            put(input+32u,a.sig,8u);put(input+40u,a.se,2u);put(input+48u,b.sig,8u);put(input+56u,b.se,2u);
            for(pl_u32 r=0u;r<32u;++r)put(input+160u+r*8u,0x123456789abc0000ull+r,8u);
            machine_state *first=records[row],*last=first+1u;memset(first,0,sizeof *first);
            for(pl_u32 r=0u;r<16u;++r)first->registers[r]=0xabcdef0123450000ull+r;
            first->rip=0x400000u;first->rflags=0xa92u;first->cr0=0x80010031u;first->cr3=0x1000u;first->cr4=32u;first->efer=0xd00u;
            first->system[MACHINE_SYSTEM_CS]=19u;first->system[MACHINE_SYSTEM_DR0+7u]=0x400u;first->retired=42u;*last=*first;
            check_x87_hardware_full(first,last,code,input,before,after,tags);check_x87_project(first,before);check_x87_project(last,after);
            first->x87_tag=tags[0];last->x87_tag=tags[1];if(last->x87_ip==(pl_u64)(uintptr_t)code)last->x87_ip=first->rip;
            last->rip+=n;++last->retired;
        }
        char meta[160];int count=snprintf(meta,sizeof meta,"{\"sourceBytes\":%u,\"stateBytes\":1256,\"native\":%u,\"bytes\":0,\"operation\":%u}\n",n,ROWS,operation);
        if(count<1||(size_t)count>=sizeof meta||save(argv[1],form,"json",meta,(size_t)count)||save(argv[1],form,"source",code,n)
            ||save(argv[1],form,"cases",records,sizeof records))return 1;
    }
    if(!VirtualFree(code,0u,MEM_RELEASE))return 1;
    printf("x87 binary special: %u profiles/%u whole physical states, all PC/RC, mask/empty/normal/extreme/NaN/sign combinations\n",form,form*ROWS);return 0;
#endif
}
