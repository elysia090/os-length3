/* An ALU accumulator's entry generation is still a distinct right operand
 * after register exchanges and simultaneous final publications. */
#define _GNU_SOURCE
#include "../src/internal/x86-selection.h"
#include "../src/selection/tree-measure.h"
#include "../src/selection/select-rules.h"
#include "../src/selection/flags.h"
#include <stdio.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <sys/mman.h>
#endif
static pl_u8 arenas[4][1024u*1024u];
typedef struct {pl_u64 ax,bx,dx,flags;} observation;
static void *executable(const pl_u8 *code,pl_u32 size)
{
#ifdef _WIN32
    void *p=VirtualAlloc(NULL,4096u,MEM_COMMIT|MEM_RESERVE,PAGE_READWRITE);if(!p)return NULL;
    memcpy(p,code,size);((pl_u8 *)p)[size]=0xc3u;DWORD old;
    if(!VirtualProtect(p,4096u,PAGE_EXECUTE_READ,&old)||!FlushInstructionCache(GetCurrentProcess(),p,size+1u)){VirtualFree(p,0u,MEM_RELEASE);return NULL;}
#else
    void *p=mmap(NULL,4096u,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);if(p==MAP_FAILED)return NULL;
    memcpy(p,code,size);((pl_u8 *)p)[size]=0xc3u;if(mprotect(p,4096u,PROT_READ|PROT_EXEC)){munmap(p,4096u);return NULL;}
#endif
    return p;
}
static void release(void *p)
{
#ifdef _WIN32
    VirtualFree(p,0u,MEM_RELEASE);
#else
    munmap(p,4096u);
#endif
}
static observation run(const void *code,pl_u64 a,pl_u64 b,pl_u64 d)
{
    observation out;pl_u64 initial_flags=0x202u|(a&1u);
    __asm__ volatile("mov %[a],%%rax;mov %[b],%%rbx;mov %[d],%%rdx;pushq %[initial];popfq;call *%[code];"
        "mov %%rax,%[ax];mov %%rbx,%[bx];mov %%rdx,%[dx];pushfq;popq %[flags]"
        :[ax]"=&r"(out.ax),[bx]"=&r"(out.bx),[dx]"=&r"(out.dx),[flags]"=&r"(out.flags)
        :[a]"r"(a),[b]"r"(b),[d]"r"(d),[initial]"r"(initial_flags),[code]"r"(code):"rax","rbx","rdx","cc","memory");
    out.flags&=0x8d5u;return out;
}
int main(void)
{
    pl_u8 source[12];const pl_u8 operations[]={0x01u,0x09u,0x11u,0x19u,0x21u,0x29u,0x31u};
    pl_x86_map map={source,0x1000u,0u,0u,PL_ELF_FLAG_READ|PL_ELF_FLAG_EXECUTE,1u};pl_x86_image image={&map,1u,0u,map.address};
    pl_x86_block_workspace first={arenas[0],arenas[1],sizeof arenas[0],128u},second={arenas[2],arenas[3],sizeof arenas[2],128u};
    unsigned comparisons=0u;
    for(unsigned width=8u;width<=64u;width*=2u)for(unsigned operation=0u;operation<7u;++operation)for(unsigned mode=0u;mode<4u;++mode){
        unsigned size=0u;source[size++]=0x48u;source[size++]=0x92u;source[size++]=0x93u;
        if(width==16u)source[size++]=0x66u;
        if(width==64u)source[size++]=0x48u;
        source[size++]=(pl_u8)(operations[operation]-(width==8u?1u:0u));source[size++]=0xd0u;source[size++]=0x48u;source[size++]=0x63u;source[size++]=0xd0u;
        map.file_bytes=map.memory_bytes=size;
        pl_x86_frontend frontend;pl_x86_block block;pl_x86_native_selection selection;pl_u8 output[256];pl_u32 bytes=0u;
        if(pl_x86_frontend_open(&image,&frontend))return 1;
        pl_u32 live=13u|((mode&1u)?0u:1u<<PL_X86_RFLAGS_LOCAL);
        if(pl_x86_block_lower_projected_until(&frontend,map.address,map.address+size,live,&first,&block))return 1;
        block.construction_fields=!!(mode&2u);
        if(pl_x86_select_write(&frontend,&second,&block,output,sizeof output,&bytes,&selection)||!selection.supported||!bytes)return 1;
        void *original=executable(source,size),*compiled=executable(output,bytes);if(!original||!compiled)return 1;
        pl_u64 seed=0x81ed5634972abcf0ull;
        for(unsigned row=0u;row<16384u;++row){seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;pl_u64 a=seed;
            seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;pl_u64 b=seed;seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;pl_u64 d=seed;
            observation expected=run(original,a,b,d),actual=run(compiled,a,b,d);if(mode&1u)expected.flags=actual.flags=0u;
            if(memcmp(&expected,&actual,sizeof actual)){fprintf(stderr,"entry ALU generation RED width%u operation%u mode%u row%u alu-frame%u emitted=",width,operation,mode,row,selection.direct_alu_frame);
                for(pl_u32 n=0u;n<bytes;++n)fprintf(stderr,"%02x",output[n]);
                for(pl_u32 node=0u;node<block.plan.node_count;++node){const pl_node *v=block.plan.nodes+node;fprintf(stderr,"\n n%u op%u",node+1u,v->opcode);
                    for(pl_u32 arg=0u;arg<v->argument_count;++arg){pl_operand value=block.plan.arguments[v->argument_at+arg];fprintf(stderr," %u:%llx",value.kind,(unsigned long long)value.value);}}
                for(pl_u32 local=0u;local<PL_X86_LOCAL_COUNT;++local){pl_operand value=block.plan.locals[local];if(value.kind!=PL_OPERAND_LOCAL||value.value!=local)fprintf(stderr,"\n l%u=%u:%llx",local,value.kind,(unsigned long long)value.value);}
                pl_operand left,right;pl_u32 bits,mode_value,carry,measured_bytes,measured_work;pl_x86_native_selection pair={0};
                if(pl_select_flag_operation_details(&block.plan,block.plan.locals[PL_X86_RFLAGS_LOCAL],&left,&right,&bits,&mode_value,&carry)){
                    int result=pl_select_measure_alu_pair(&frontend,&block,&pair,0u,left,right,bits,mode_value,carry,0u,block.plan.node_count+1u,0u,&measured_bytes,&measured_work);
                    fprintf(stderr,"\n pair %u:%llx %u:%llx mode%u result%d alias%u:%llx@%u/%u",left.kind,(unsigned long long)left.value,right.kind,(unsigned long long)right.value,mode_value,result,selection.frame_alias_kind,(unsigned long long)selection.frame_alias_value,selection.frame_alias_local,selection.frame_alias_present);}
                fputc('\n',stderr);release(original);release(compiled);return 1;}
            ++comparisons;
        }release(original);release(compiled);
    }
    printf("entry ALU generation: %u independent full/projected/relocation-state comparisons\n",comparisons);return 0;
}
