#define _GNU_SOURCE
#include "x87-observation.h"
#include <x86/decode.h>
#include <stdio.h>
#include <stdint.h>
#include <sys/mman.h>
extern void native_fxsave(machine_state *,const void *,const void *,void *,void *);
typedef struct { pl_u64 significand;pl_u16 se;pl_u8 empty; } value;
static const value values[]={
    {0u,0u,0u},{0u,0x8000u,0u},{0x8000000000000000ull,0x3fffu,0u},
    {0x8000000000000001ull,0x3fffu,0u},{0x8000000000000000ull,0xbfffu,0u},
    {0xc000000000000000ull,0x3fffu,0u},{1u,0u,0u},{2u,0u,0u},
    {0x8000000000000000ull,0u,0u},{0x8000000000000000ull,1u,0u},
    {0x8000000000000000ull,0x7fffu,0u},{0x8000000000000000ull,0xffffu,0u},
    {0xc000000000000001ull,0x7fffu,0u},{0x8000000000000001ull,0x7fffu,0u},
    {1u,1u,0u},{0x8000000000000000ull,0x3fffu,1u}
};
static machine_state observations[sizeof values/sizeof values[0]][sizeof values/sizeof values[0]][2];
static void put(void *at,pl_u64 number,pl_u32 bytes){for(pl_u32 i=0u;i<bytes;++i)((pl_u8 *)at)[i]=(pl_u8)(number>>(i*8u));}
static int save(const char *directory,pl_u32 form,const char *suffix,const void *bytes,size_t count)
{
    if(!directory)return 0;
    char path[4096];int n=snprintf(path,sizeof path,"%s/x87-compare-%u.%s",directory,form,suffix);
    if(n<1||(size_t)n>=sizeof path)return 1;
    FILE *file=fopen(path,"wbx");if(!file)return 1;
    int failed=fwrite(bytes,1u,count,file)!=count;if(fclose(file))failed=1;return failed;
}
int main(int argc,char **argv)
{
    if(argc>2)return 2;
    const char *directory=argc==2?argv[1]:NULL;
    pl_u8 *code=mmap(NULL,4096u,PROT_READ|PROT_WRITE|PROT_EXEC,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if(code==MAP_FAILED)return 1;
    pl_u32 count=(pl_u32)(sizeof values/sizeof values[0]),rows=0u;
    pl_u32 cpuid_a=0u,cpuid_b,cpuid_c,cpuid_d;char vendor[13];
    __asm__ volatile("cpuid":"+a"(cpuid_a),"=b"(cpuid_b),"=c"(cpuid_c),"=d"(cpuid_d));
    memcpy(vendor,&cpuid_b,4u);memcpy(vendor+4u,&cpuid_d,4u);memcpy(vendor+8u,&cpuid_c,4u);vendor[12]=0;
    pl_u64 status_changes=0u,unmasked=0u,pop_suppressed=0u,c1_kept=0u;int failed=1;
    for(pl_u32 form=0u;form<64u;++form){pl_u32 index=form&7u,mode=(form>>3u)&3u,mask=(form>>5u)&1u;
        code[0]=(pl_u8)(mode&1u?0xdfu:0xdbu);code[1]=(pl_u8)((mode&2u?0xf0u:0xe8u)+index);code[2]=0xc3u;
        pl_x86_map map={code,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
        pl_x86_instruction decoded;if(pl_x86_decode_profile(&image,map.address,&decoded)
            ||decoded.status!=PL_X86_DECODE_VALID||decoded.source_bytes!=2u||decoded.machine_operation!=PL_X86_MACHINE_X87
            ||decoded.visible_operand_count!=2u||decoded.operands[1].value.reg.index!=index)return 1;
        for(pl_u32 left=0u;left<count;++left)for(pl_u32 right=0u;right<count;++right){
            _Alignas(16) pl_u8 input[512]={0},before[512],after[512];pl_u32 top=(left+right)&7u;
            put(input,mask?0x37cu:0x37fu,2u);put(input+2u,0x4700u|(top<<11u),2u);input[4u]=255u;
            put(input+6u,0x123u,2u);put(input+8u,0x12340000u,8u);put(input+16u,0x56780000u,8u);put(input+24u,0x1f80u,4u);
            for(pl_u32 i=0u;i<8u;++i){put(input+32u+i*16u,0x8000000000000000ull+i,8u);put(input+40u+i*16u,0x3fffu,2u);}
            const value *a=values+left,*b=values+(index?right:left);
            put(input+32u,a->significand,8u);put(input+40u,a->se,2u);
            put(input+32u+index*16u,b->significand,8u);put(input+40u+index*16u,b->se,2u);
            if(a->empty)input[4u]=(pl_u8)(input[4u]&~(1u<<top));
            if(b->empty)input[4u]=(pl_u8)(input[4u]&~(1u<<((top+index)&7u)));
            machine_state *first=&observations[left][right][0],*last=first+1u;memset(first,0,sizeof *first);
            for(pl_u32 r=0u;r<16u;++r)first->registers[r]=0x123456789abc0000ull+r;
            first->rip=map.address;first->rflags=0xad7u;first->cr0=0x80010031u;first->cr3=0x1000u;first->cr4=32u;first->efer=0xd00u;
            first->retired=42u;first->system[MACHINE_SYSTEM_CS]=19u;first->system[MACHINE_SYSTEM_DR0+7u]=0x400u;*last=*first;
            native_fxsave(last,code,input,before,after);first->registers[4u]=last->registers[4u];
            check_x87_project(first,before);check_x87_project(last,after);
            // Bind a native code-map coordinate to the diagnostic guest map.
            // This is oracle loading, not runtime branch/opcode interpretation.
            if(last->x87_ip>=(pl_u64)(uintptr_t)code&&last->x87_ip-(pl_u64)(uintptr_t)code<4096u)
                last->x87_ip=map.address+last->x87_ip-(pl_u64)(uintptr_t)code;
            last->rip+=2u;++last->retired;++rows;
            status_changes+=first->x87_status!=last->x87_status;
            if(last->x87_status&0x80u){++unmasked;pop_suppressed+=(mode&1u)&&((first->x87_status&0x3800u)==(last->x87_status&0x3800u));}
            c1_kept+=(last->x87_status&0x200u)!=0u;
        }
        char json[256];int n=snprintf(json,sizeof json,"{\"entry\":\"4194304\",\"sourceBytes\":2,\"stateBytes\":%zu,\"native\":%u,\"sourceIndex\":%u,\"ordered\":%u,\"pop\":%u,\"unmasked\":%u}\n",sizeof(machine_state),count*count,index,(mode>>1u)&1u,mode&1u,mask);
        if(n<1||(size_t)n>=sizeof json||save(directory,form,"json",json,(size_t)n)||save(directory,form,"cases",observations,sizeof observations)
            ||save(directory,form,"source",code,2u))goto done;
    }
    printf("{\"format\":\"native-x87-compare-observations-v1\",\"rows\":%u,\"forms\":64,\"vendor\":\"%s\",\"statusChanges\":%llu,\"unmasked\":%llu,\"popSuppressed\":%llu,\"c1Kept\":%llu,\"runtimeImplementation\":\"not-added\",\"oracle\":\"build QEMU CPU, not silicon\"}\n",rows,vendor,(unsigned long long)status_changes,(unsigned long long)unmasked,(unsigned long long)pop_suppressed,(unsigned long long)c1_kept);
    failed=0;
done:if(munmap(code,4096u))failed=1;return failed;
}
