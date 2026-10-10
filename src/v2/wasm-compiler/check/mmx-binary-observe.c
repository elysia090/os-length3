#include "x87-hardware.h"
#include <stdio.h>
#include <stdint.h>
#ifdef _WIN32
static machine_state records[32][2];static pl_u64 operands[32][2];static const char *record_prefix="mmx-binary";
static int save(const char *dir,pl_u32 form,const char *suffix,const void *data,size_t bytes)
{
    char path[4096];int n=snprintf(path,sizeof path,"%s/%s-%u.%s",dir,record_prefix,form,suffix);if(n<1||(size_t)n>=sizeof path)return 1;
    FILE *file=fopen(path,"wbx");if(!file)return 1;int bad=fwrite(data,1u,bytes,file)!=bytes;if(fclose(file))bad=1;return bad;
}
static void put(pl_u8 *at,pl_u64 word,pl_u32 bytes)
{for(pl_u32 i=0u;i<bytes;++i)at[i]=(pl_u8)(word>>(i*8u));}
static pl_u64 random_word(pl_u64 *seed)
{*seed^=*seed<<13u;*seed^=*seed>>7u;*seed^=*seed<<17u;return *seed;}
static int transfer(const char *dir,pl_u8 *code)
{
    const pl_u8 indices[]={0u,5u,7u};pl_u32 form=0u;pl_u64 seed=0x6d6d786d6f766571ull,written[32];record_prefix="mmx-transfer";
    for(pl_u32 kind=0u;kind<10u;++kind)for(pl_u32 reg=0u;reg<3u;++reg)for(pl_u32 address=0u;address<2u;++address,++form){
        pl_u32 index=indices[reg],memory=kind>=5u,store=kind==6u||kind==8u||kind==9u,bytes=kind==0u||kind==1u||kind==7u||kind==8u?4u:8u,n=0u;DWORD old;
        if(!VirtualProtect(code,4096u,PAGE_READWRITE,&old))return 1;
        if(address)code[n++]=0x67u;
        if(kind==2u||kind==3u)code[n++]=0x48u;
        code[n++]=0x0fu;code[n++]=(pl_u8)(kind==0u||kind==2u||kind==7u?0x6eu:kind==1u||kind==3u||kind==8u?0x7eu:kind==6u?0x7fu:kind==9u?0xe7u:0x6fu);
        code[n++]=(pl_u8)((memory?0u:0xc0u)|(index<<3u)|(memory?5u:kind==4u?(index+3u)&7u:0u));
        if(memory){put(code+n,4096u-n-4u,4u);n+=4u;}code[n]=0xc3u;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&old)||!FlushInstructionCache(GetCurrentProcess(),code,n+1u))return 1;
        for(pl_u32 row=0u;row<32u;++row){pl_u32 top=row&7u;_Alignas(16) pl_u8 input[512]={0},before[512],after[512];pl_u16 tags[2];
            put(input,0x37fu,2u);put(input+2u,0x4700u|(top<<11u),2u);input[4]=(pl_u8)(row&8u?0x5au:255u);
            put(input+6u,0x123u,2u);put(input+8u,0x12340000u,8u);put(input+16u,0x56780000u,8u);put(input+24u,0x1f80u,4u);
            for(pl_u32 physical=0u;physical<8u;++physical){pl_u32 logical=(physical+8u-top)&7u;
                put(input+32u+logical*16u,random_word(&seed),8u);put(input+40u+logical*16u,0x3fffu,2u);}
            operands[row][0]=random_word(&seed);operands[row][1]=0u;put(code+4096u,operands[row][0],8u);
            machine_state *a=records[row],*b=a+1u;memset(a,0,sizeof *a);for(pl_u32 r=0u;r<16u;++r)a->registers[r]=0x123456789abc0000ull+r;
            a->registers[0]=random_word(&seed);a->rip=0x400000u;a->rflags=0xa92u|(row&1u);a->cr0=0x80010031u;a->cr3=0x1000u;a->cr4=32u;a->efer=0xd00u;
            a->system[MACHINE_SYSTEM_CS]=19u;a->system[MACHINE_SYSTEM_DR0+7u]=0x400u;a->retired=42u;*b=*a;
            check_x87_hardware_full(a,b,code,input,before,after,tags);check_x87_project(a,before);check_x87_project(b,after);a->x87_tag=tags[0];b->x87_tag=tags[1];
            if(b->x87_ip==(pl_u64)(uintptr_t)code)b->x87_ip=a->rip;
            if(b->x87_dp==(pl_u64)(uintptr_t)(code+4096u))b->x87_dp=a->rip+4096u;
            b->rip+=n;++b->retired;written[row]=check_x87_read(code+4096u,8u);
        }
        char json[256];int count=snprintf(json,sizeof json,"{\"sourceBytes\":%u,\"stateBytes\":%zu,\"native\":32,\"bytes\":%u,\"store\":%s,\"operandOffset\":4096,\"operandStride\":16,\"registerBytes\":8,\"fullTagObserved\":true}\n",n,sizeof(machine_state),memory?bytes:0u,store?"true":"false");
        if(count<1||(size_t)count>=sizeof json||save(dir,form,"json",json,(size_t)count)||save(dir,form,"source",code,n)
            ||save(dir,form,"cases",records,sizeof records)||save(dir,form,"integers",operands,sizeof operands)||save(dir,form,"written",written,sizeof written))return 1;
    }
    printf("MMX transfer observed: %u forms / %u full RAX/FPU/flags/tag/memory rows\n",form,form*32u);return 0;
}
#endif
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    int standard=argc==3&&!strcmp(argv[2],"--standard");
    int absolute=argc==3&&!strcmp(argv[2],"--absolute");
    int extended=argc==3&&(!strcmp(argv[2],"--extended")||!strcmp(argv[2],"--wide-extended"));
    int moves=argc==3&&!strcmp(argv[2],"--transfer"),tag_first=argc==3&&!strcmp(argv[2],"--tag-first"),wide=standard||(argc==3&&(!strcmp(argv[2],"--wide")||!strcmp(argv[2],"--wide-extended")));if(argc!=2&&!tag_first&&!wide&&!moves&&!extended&&!absolute)return 2;
    if(absolute)record_prefix="mmx-absolute";else if(standard)record_prefix="packed-standard";else if(extended)record_prefix=wide?"packed-extended":"mmx-extended";else if(wide)record_prefix="packed-binary";
    pl_u8 *code=NULL;for(uintptr_t address=0x10000000u;!code&&address<0x70000000u;address+=65536u)
        code=VirtualAlloc((void *)address,8192u,MEM_COMMIT|MEM_RESERVE,PAGE_READWRITE);
    if(!code)return 1;
    if(moves){int result=transfer(argv[1],code);if(!VirtualFree(code,0u,MEM_RELEASE))result=1;return result;}
    const pl_u8 opcodes[]={0xef,0xdb,0xeb,0xdf,0xfc,0xfd,0xfe,0xd4,0x74,0x75,0x76,0xf8,0xf9,0xfa,0xfb,
        0x64,0x65,0x66,0xec,0xed,0xdc,0xdd,0xe8,0xe9,0xd8,0xd9,0xda,0xea,0xde,0xee,0xe0,0xe3,0xd5,
        0xf5,0xe4,0xe5,0xf4,0x67,0x6b,0x63,0xf6,0x0b};
    const pl_u8 standard_opcodes[]={0x38,0x39,0x3a,0x3b,0x3c,0x3d,0x3e,0x3f,0x29,0x37,0x40,0x28,0x2b,0x1c,0x1d,0x1e};
    const pl_u8 targets[]={0u,5u,7u,9u,15u},prefixes[]={0u,0x67u,0x48u};pl_u32 forms=0u;pl_u64 seed=0x6d6d7862696e6172ull;int failed=1;
    for(pl_u32 family=absolute?55u:standard?42u:extended?33u:0u;family<(absolute||standard?58u:extended?42u:33u);++family)for(pl_u32 dst=0u;dst<(wide?5u:3u);++dst)for(pl_u32 mode=0u;mode<3u;++mode)
    for(pl_u32 prefix=0u;prefix<3u;++prefix,++forms){DWORD old;pl_u32 destination=targets[dst],source=(destination+3u)&(wide?15u:7u),n=0u;
        if(!VirtualProtect(code,4096u,PAGE_READWRITE,&old))goto done;
        if(wide){if(prefixes[prefix]==0x67u)code[n++]=0x67u;code[n++]=0x66u;
            pl_u32 rex=(prefixes[prefix]==0x48u?8u:0u)|(destination>=8u?4u:0u)|(mode==1u&&source>=8u?1u:mode==0u&&destination>=8u?1u:0u);
            if(rex)code[n++]=(pl_u8)(0x40u|rex);}
        else if(prefixes[prefix])code[n++]=prefixes[prefix];
        code[n++]=0x0fu;if(family>=41u)code[n++]=0x38u;code[n++]=family<42u?opcodes[family]:standard_opcodes[family-42u];
        code[n++]=(pl_u8)((mode==2u?0u:0xc0u)|((destination&7u)<<3u)|(mode==2u?5u:(mode==0u?destination:source)&7u));
        if(mode==2u){put(code+n,4096u-n-4u,4u);n+=4u;}
        pl_u32 tail=n;if(tag_first){code[tail++]=0xd9u;code[tail++]=0x35u;put(code+tail,4112u-tail-4u,4u);tail+=4u;}code[tail]=0xc3u;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&old)||!FlushInstructionCache(GetCurrentProcess(),code,tail+1u))goto done;
        for(pl_u32 row=0u;row<32u;++row){pl_u32 top=row&7u;_Alignas(16) pl_u8 input[512]={0},before[512],after[512];pl_u16 tags[2];
            put(input,0x37fu,2u);put(input+2u,0x4700u|(top<<11u),2u);input[4]=(pl_u8)(row&8u?0x5au:0xffu);
            put(input+6u,0x123u,2u);put(input+8u,0x12340000u,8u);put(input+16u,0x56780000u,8u);put(input+24u,0x1f80u,4u);
            const pl_u64 edges[]={0u,~0ull,0x8000800080008000ull,0x7fff7fff7fff7fffull,0x00ff00ff00ff00ffull,0xff00ff00ff00ff00ull,1u,0x8080808080808080ull,
                0x8000000080000000ull,0x7fffffff7fffffffull,0x0000ffff00010000ull,0xffffffffffff0000ull,0x8000000000000000ull,0x7fffffffffffffffull,0x0000000100000001ull,0xffffffff00000001ull};
            pl_u32 edge_count=standard?16u:8u;
            for(pl_u32 physical=0u;physical<8u;++physical){pl_u32 logical=(physical+8u-top)&7u;pl_u64 value=row<16u?edges[(row+physical)%8u]:random_word(&seed);
                put(input+32u+logical*16u,value,8u);put(input+40u+logical*16u,0x3fffu,2u);}
            for(pl_u32 half=0u;half<2u;++half){operands[row][half]=row<16u?edges[(row*3u+half*5u)%edge_count]:random_word(&seed);put(code+4096u+half*8u,operands[row][half],8u);}
            if(wide)for(pl_u32 reg=0u;reg<16u;++reg)for(pl_u32 half=0u;half<2u;++half)put(input+160u+reg*16u+half*8u,row<16u?edges[(row+reg+half)%edge_count]:random_word(&seed),8u);
            machine_state *a=records[row],*b=a+1u;memset(a,0,sizeof *a);for(pl_u32 r=0u;r<16u;++r)a->registers[r]=0x123456789abc0000ull+r;
            a->rip=0x400000u;a->rflags=0xa92u|(row&1u);a->cr0=0x80010031u;a->cr3=0x1000u;a->cr4=wide?544u:32u;a->efer=0xd00u;
            a->system[MACHINE_SYSTEM_CS]=19u;a->system[MACHINE_SYSTEM_DR0+7u]=0x400u;a->retired=42u;*b=*a;
            check_x87_hardware_full(a,b,code,input,before,after,tags);check_x87_project(a,before);check_x87_project(b,after);a->x87_tag=tags[0];b->x87_tag=tag_first?(pl_u16)check_x87_read(code+4120u,2u):tags[1];
            if(b->x87_ip==(pl_u64)(uintptr_t)code)b->x87_ip=a->rip;
            if(b->x87_dp==(pl_u64)(uintptr_t)(code+4096u))b->x87_dp=a->rip+4096u;
            b->rip+=n;++b->retired;
        }
        char json[256];int count=snprintf(json,sizeof json,"{\"sourceBytes\":%u,\"stateBytes\":%zu,\"native\":32,\"bytes\":%u,\"operandOffset\":4096,\"operandStride\":16,\"registerBytes\":%u,\"fullTagObserved\":true}\n",n,sizeof(machine_state),mode==2u?(wide?16u:8u):0u,wide?16u:8u);
        if(count<1||(size_t)count>=sizeof json||save(argv[1],forms,"json",json,(size_t)count)||save(argv[1],forms,"source",code,n)
            ||save(argv[1],forms,"cases",records,sizeof records)||save(argv[1],forms,"integers",operands,sizeof operands))goto done;
    }
    printf("Packed%u observed: %u forms / %u complete FPU/RFLAGS/full-tag rows\n",wide?128u:64u,forms,forms*32u);failed=0;
done:if(!VirtualFree(code,0u,MEM_RELEASE))failed=1;return failed;
#endif
}
