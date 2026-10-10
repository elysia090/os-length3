#include "x87-hardware.h"
#include <stdio.h>
#ifdef _WIN32
static machine_state records[32][2];static pl_u8 operands[32][16];
static void put(pl_u8 *p,pl_u64 word,pl_u32 n){for(pl_u32 b=0u;b<n;++b)p[b]=(pl_u8)(word>>(b*8u));}
static pl_u64 random_word(pl_u64 *s){*s^=*s<<13u;*s^=*s>>7u;*s^=*s<<17u;return *s;}
static int save(const char *dir,pl_u32 form,const char *suffix,const void *data,size_t n)
{
    char name[4096];int count=snprintf(name,sizeof name,"%s/vector-string-%u.%s",dir,form,suffix);
    if(count<1||(size_t)count>=sizeof name)return 1;
    FILE *f=fopen(name,"wbx");if(!f)return 1;
    int bad=fwrite(data,1u,n,f)!=n;if(fclose(f))bad=1;return bad;
}
/* Oracle-only extension of the FP receipt: these instructions also consume
 * RAX/RDX and may replace RCX. Capture all three physical parent registers. */
static void observe(machine_state *a,machine_state *b,const void *code,const void *input,void *before,void *after,pl_u16 tags[2])
{
    _Alignas(16) pl_u8 host[512],old_env[32],new_env[32];pl_u64 old_flags,new_flags,out[3];
    __asm__ volatile("fxsave64 %[host];fxrstor64 %[input];fnstenv %[old_env];fldcw %[input];fxsave64 %[before];"
        "pushq %[flags];popfq;pushfq;popq %[old];mov %[ax],%%rax;mov %[cx],%%rcx;mov %[dx],%%rdx;call *%[code];"
        "mov %%rax,%[out_ax];mov %%rcx,%[out_cx];mov %%rdx,%[out_dx];pushfq;popq %[new];"
        "fxsave64 %[after];fnstenv %[new_env];fxrstor64 %[host];cld"
        :[host]"=m"(host),[before]"=m"(*(pl_u8 (*)[512])before),[after]"=m"(*(pl_u8 (*)[512])after),
         [old_env]"=m"(old_env),[new_env]"=m"(new_env),[out_ax]"=m"(out[0]),[out_cx]"=m"(out[1]),[out_dx]"=m"(out[2]),
         [old]"=&r"(old_flags),[new]"=&r"(new_flags)
        :[input]"m"(*(const pl_u8 (*)[512])input),[code]"r"(code),[flags]"r"(a->rflags),
         [ax]"m"(a->registers[0]),[cx]"m"(a->registers[1]),[dx]"m"(a->registers[2]):"memory","cc","rax","rcx","rdx");
    a->rflags=old_flags;b->rflags=new_flags;for(pl_u32 r=0u;r<3u;++r)b->registers[r]=out[r];
    tags[0]=(pl_u16)check_x87_read(old_env+8u,2u);tags[1]=(pl_u16)check_x87_read(new_env+8u,2u);
}
#endif
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    if(argc!=2)return 2;
    pl_u8 *code=check_x87_allocate(8192u);if(!code)return 1;
    pl_u64 seed=0x6d795f737472696eull;pl_u32 form=0u;
    const pl_u64 lengths[]={0u,1u,~0ull,7u,8u,9u,15u,16u,17u,~6ull,~7ull,~8ull,~14ull,~15ull,~16ull,
        0x80000000u,0x7fffffffu,0x100000000ull,0x8000000000000000ull,0x7fffffffffffffffull,0xffffffff00000001ull};
    for(pl_u32 opcode=0x60u;opcode<=0x63u;++opcode)for(pl_u32 control=0u;control<128u;++control)
    for(pl_u32 wide=0u;wide<2u;++wide)for(pl_u32 target=0u;target<2u;++target)for(pl_u32 mode=0u;mode<3u;++mode,++form){
        pl_u32 dst=target?9u:0u,src=mode==0u?dst:7u,n=0u,offset=4097u;DWORD old;
        if(!VirtualProtect(code,4096u,PAGE_READWRITE,&old))return 1;
        code[n++]=0x66u;pl_u32 rex=(wide?8u:0u)|(dst>=8u?4u:0u)|(mode!=2u&&src>=8u?1u:0u);
        if(rex)code[n++]=(pl_u8)(0x40u|rex);
        code[n++]=0x0fu;code[n++]=0x3au;code[n++]=(pl_u8)opcode;
        code[n++]=(pl_u8)((mode==2u?0u:0xc0u)|((dst&7u)<<3u)|(mode==2u?5u:src&7u));
        if(mode==2u){put(code+n,offset-n-5u,4u);n+=4u;}code[n++]=(pl_u8)control;code[n]=0xc3u;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&old)||!FlushInstructionCache(GetCurrentProcess(),code,n+1u))return 1;
        for(pl_u32 row=0u;row<32u;++row){_Alignas(16) pl_u8 input[512]={0},before[512],after[512];pl_u16 tags[2];
            put(input,0x37fu,2u);put(input+2u,(row&7u)<<11u,2u);input[4]=255u;put(input+24u,0x1f80u,4u);
            for(pl_u32 r=0u;r<8u;++r){put(input+32u+r*16u,random_word(&seed),8u);put(input+40u+r*16u,0x3fffu,2u);}
            for(pl_u32 r=0u;r<32u;++r)put(input+160u+r*8u,random_word(&seed),8u);
            for(pl_u32 byte=0u;byte<16u;++byte){pl_u8 av=(pl_u8)random_word(&seed),bv=(pl_u8)random_word(&seed);
                if(row<16u){av=(pl_u8)(byte+row);bv=(pl_u8)(byte+row+(row&3u));}
                input[160u+dst*16u+byte]=av;operands[row][byte]=bv;if(mode==1u)input[160u+src*16u+byte]=bv;}
            if(row<20u){pl_u32 width=1u+(control&1u),stop=(row*3u)%(16u/width+1u);
                if(stop<16u/width){put(input+160u+dst*16u+stop*width,0u,width);put(operands[row]+stop*width,0u,width);
                    if(mode==1u)put(input+160u+src*16u+stop*width,0u,width);}}
            memcpy(code+offset,operands[row],16u);machine_state *a=records[row],*b=a+1u;memset(a,0,sizeof *a);
            for(pl_u32 r=0u;r<16u;++r)a->registers[r]=0x123456789abc0000ull+r;
            a->registers[0]=lengths[row%21u];a->registers[2]=lengths[(row*7u)%21u];a->rip=0x400000u;a->rflags=0xa92u|(row&1u);
            a->cr0=0x80010031u;a->cr3=0x1000u;a->cr4=544u;a->efer=0xd00u;a->system[MACHINE_SYSTEM_CS]=19u;
            a->system[MACHINE_SYSTEM_DR0+7u]=0x400u;a->retired=42u;*b=*a;
            observe(a,b,code,input,before,after,tags);check_x87_project(a,before);check_x87_project(b,after);
            a->x87_tag=tags[0];b->x87_tag=tags[1];b->rip+=n;++b->retired;
        }
        char meta[256];int count=snprintf(meta,sizeof meta,"{\"sourceBytes\":%u,\"stateBytes\":%zu,\"native\":32,\"bytes\":%u,\"operandOffset\":4097,\"operandStride\":16}\n",n,sizeof(machine_state),mode==2u?16u:0u);
        if(count<1||(size_t)count>=sizeof meta||save(argv[1],form,"json",meta,(size_t)count)||save(argv[1],form,"source",code,n)
            ||save(argv[1],form,"cases",records,sizeof records)||save(argv[1],form,"integers",operands,sizeof operands))return 1;
    }
    if(!VirtualFree(code,0u,MEM_RELEASE))return 1;
    printf("PCMP strings: %u forms/%u complete RAX/RCX/RDX/FPU/flags states\n",form,form*32u);return 0;
#endif
}
