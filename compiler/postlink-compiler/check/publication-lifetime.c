/* Independent CPU comparison: a Boolean output cannot destroy an entry
 * generation still needed by a sibling pointer publication. */
#define _GNU_SOURCE
#include "../src/internal/x86-selection.h"
#include "../src/selection/branch-frame.h"
#include <stdio.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <sys/mman.h>
#endif
static pl_u8 arenas[4][1024u*1024u];
typedef struct {pl_u64 ax,cx,flags;} observation;
static void *executable(const pl_u8 *code,pl_u32 bytes)
{
#ifdef _WIN32
    void *p=VirtualAlloc(NULL,4096u,MEM_COMMIT|MEM_RESERVE,PAGE_READWRITE);if(!p)return NULL;
    memcpy(p,code,bytes);((pl_u8 *)p)[bytes]=0xc3u;DWORD old;
    if(!VirtualProtect(p,4096u,PAGE_EXECUTE_READ,&old)||!FlushInstructionCache(GetCurrentProcess(),p,bytes+1u)){VirtualFree(p,0u,MEM_RELEASE);return NULL;}
#else
    void *p=mmap(NULL,4096u,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);if(p==MAP_FAILED)return NULL;
    memcpy(p,code,bytes);((pl_u8 *)p)[bytes]=0xc3u;
    if(mprotect(p,4096u,PROT_READ|PROT_EXEC)){munmap(p,4096u);return NULL;}
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
static observation run(const void *code,pl_u64 value,pl_u64 character)
{
    observation out;
    __asm__ volatile("mov %[ch],%%r12\n\tmov %[value],%%rax\n\tcall *%[code]\n\t"
        "mov %%rax,%[ax]\n\tmov %%rcx,%[cx]\n\tpushfq\n\tpopq %[flags]"
        :[ax]"=&r"(out.ax),[cx]"=&r"(out.cx),[flags]"=&r"(out.flags)
        :[ch]"r"(character),[value]"r"(value),[code]"r"(code):"rax","rcx","r12","cc","memory");
    out.flags&=0x8d5u;return out;
}
int main(void)
{
    const pl_u8 source[]={0x48,0x89,0xc1,0x31,0xc0,0x41,0x80,0xfc,0x2d,0x0f,0x94,0xc0};
    pl_x86_map map={source,0x1000u,sizeof source,sizeof source,PL_ELF_FLAG_READ|PL_ELF_FLAG_EXECUTE,1u};
    pl_x86_image image={&map,1u,0u,map.address};pl_x86_frontend frontend;pl_x86_block block;
    pl_x86_block_workspace first={arenas[0],arenas[1],sizeof arenas[0],128u},second={arenas[2],arenas[3],sizeof arenas[2],128u};
    unsigned comparisons=0u;
    for(unsigned mode=0u;mode<4u;++mode){
    pl_u8 output[256];pl_u32 bytes=0u;pl_x86_native_selection selection;
    if(pl_x86_frontend_open(&image,&frontend))return 1;
    int status=(mode&1u)?pl_x86_block_lower_projected_until(&frontend,map.address,map.address+sizeof source,3u,&first,&block)
        :pl_x86_block_lower(&frontend,map.address,&first,&block);
    if(status)return 1;
    block.construction_fields=!!(mode&2u);
    if(!status&&!(mode&1u)){
        flag_result_group group;pl_operand flags=block.plan.locals[PL_X86_RFLAGS_LOCAL];
        if(flags.kind==PL_OPERAND_NODE&&pl_select_compare_boolean_group_shape(&block.plan,3u,(pl_u32)flags.value,&group)){
            fprintf(stderr,"publication lifetime RED: Boolean group consumes RAX before pending RCX captures entry RAX\n");return 1;}
    }
    if(mode==0u){
        /* Zero-parent SETcc also has this exact normalized spelling. Entry
         * lifetimes cannot depend on a producer retaining an extension node. */
        for(pl_u32 node=1u;node<=block.plan.node_count;++node)
            if(block.plan.nodes[node-1u].opcode==PL_OPCODE_X86_COMPARE){
                pl_plan normalized=block.plan;flag_result_group group;
                normalized.locals[0]=(pl_operand){PL_OPERAND_PROJECTION,((pl_u64)node<<8u)|4u};
                normalized.locals[1]=(pl_operand){PL_OPERAND_LOCAL,0u};
                if(pl_select_compare_boolean_group_shape(&normalized,3u,node,&group)){
                    fprintf(stderr,"publication lifetime RED: normalized Boolean group destroys pending entry generation\n");return 1;}
            }
    }
    if(status||pl_x86_select_write(&frontend,&second,&block,output,sizeof output,&bytes,&selection)||!selection.supported||!bytes||bytes>=sizeof output)return 1;
    void *original=executable(source,sizeof source),*compiled=executable(output,bytes);if(!original||!compiled)return 1;
    pl_u64 value=0x8172635445362718ull;
    for(unsigned sample=0u;sample<64u;++sample)for(unsigned ch=0u;ch<256u;++ch){
        value^=value<<13u;value^=value>>7u;value^=value<<17u;
        observation expected=run(original,value,ch),actual=run(compiled,value,ch);
        if(mode&1u)expected.flags=actual.flags=0u;
        if(memcmp(&expected,&actual,sizeof actual)){
            fprintf(stderr,"publication lifetime RED: mode=%u ch=%u entry=%llx expected ax/cx=%llx/%llx actual=%llx/%llx emitted=",
                mode,ch,(unsigned long long)value,(unsigned long long)expected.ax,(unsigned long long)expected.cx,(unsigned long long)actual.ax,(unsigned long long)actual.cx);
            for(pl_u32 i=0u;i<bytes;++i)fprintf(stderr,"%02x",output[i]);
            fputc('\n',stderr);release(original);release(compiled);return 1;
        }++comparisons;
    }
    release(original);release(compiled);
    }
    printf("publication lifetime: %u independent full/projected entry-pointer/Boolean/RFLAGS comparisons\n",comparisons);return 0;
}
