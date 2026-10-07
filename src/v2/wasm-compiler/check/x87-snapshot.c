#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include "x87-observation.h"
#include "fault-admission.h"
#include <stdio.h>
#include <stdint.h>
#include <sys/mman.h>
extern void native_fxsave(machine_state *,const void *,const void *,void *,void *);
static pl_u8 page[4096],module[65536];
static machine_state records[32][2];static pl_u16 words[32];
static pl_u64 random_word(pl_u64 *seed){*seed^=*seed<<13u;*seed^=*seed>>7u;*seed^=*seed<<17u;return *seed;}
static void put(void *at,pl_u64 value,pl_u32 bytes){for(pl_u32 i=0u;i<bytes;++i)((pl_u8 *)at)[i]=(pl_u8)(value>>(i*8u));}
static int save(const char *directory,pl_u32 form,const char *suffix,const void *bytes,size_t count)
{
    if(!directory)return 0;
    char path[4096];int n=snprintf(path,sizeof path,"%s/x87-snapshot-%u.%s",directory,form,suffix);
    if(n<1||(size_t)n>=sizeof path)return 1;
    FILE *file=fopen(path,"wbx");if(!file)return 1;
    int failed=fwrite(bytes,1u,count,file)!=count;if(fclose(file))failed=1;return failed;
}
static int law_checks(const pl_x86_image *image)
{
    pl_x86_instruction decoded;pl_x86_x87_snapshot law;
    if(pl_x86_decode_profile(image,image->entry,&decoded)||!pl_x86_x87_snapshot_lower(&decoded,&law))return 1;
    for(pl_u32 kind=0u;kind<12u;++kind){pl_x86_instruction changed=decoded;
        switch(kind){case 0:changed.status=PL_X86_DECODE_INVALID;break;
        case 1:changed.machine_argument^=1ull<<48u;break;case 2:changed.visible_operand_count=0u;break;
        case 3:changed.operands[0].bits=32u;break;case 4:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;
        case 5:changed.flags|=PL_X86_INSTRUCTION_REPEATED;break;case 6:changed.flags|=PL_X86_INSTRUCTION_READS_MEMORY;break;
        case 7:changed.flags|=PL_X86_INSTRUCTION_TRAP_AFTER;break;case 8:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;
        case 9:changed.flags&=~PL_X86_INSTRUCTION_PRECISE_CUT;break;case 10:changed.machine_operation=PL_X86_MACHINE_NONE;break;
        default:changed.operands[0].kind=PL_X86_OPERAND_IMMEDIATE;break;}
        pl_x86_x87_snapshot out={0xa5u,0xa5u},before=out;if(pl_x86_x87_snapshot_lower(&changed,&out)||memcmp(&out,&before,sizeof out))return 1;
        pl_u8 scratch[8192];pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;
        if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;
    }
    return 0;
}
int main(int argc,char **argv)
{
    if(argc>2)return 2;
    const char *directory=argc==2?argv[1]:NULL;
    pl_u8 *code=mmap(NULL,4096u,PROT_READ|PROT_WRITE|PROT_EXEC,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    pl_u8 *target=mmap(NULL,8192u,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS|MAP_32BIT,-1,0);
    if(code==MAP_FAILED||target==MAP_FAILED)return 1;
    const pl_u8 prefixes[][2]={{0u,0u},{0x66u,0u},{0x67u,0u},{0x48u,0u},{0x66u,0x67u},{0xf2u,0u},{0xf3u,0u},{0x67u,0x48u}};
    pl_u64 seed=0x761ffaee912333ull;pl_u32 observations=0u;int failed=1;
    for(pl_u32 form=0u;form<24u;++form){pl_u32 variant=form%3u,prefix=form/3u,length=0u;
        memset(page,0x90,sizeof page);for(pl_u32 i=0u;i<2u&&prefixes[prefix][i];++i)page[length++]=prefixes[prefix][i];
        page[length++]=variant==0u?0xdfu:variant==1u?0xddu:0xd9u;page[length++]=variant==0u?0xe0u:0x3fu;
        memcpy(code,page,sizeof page);code[length]=0xc3u;
        pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
        wasm_cut_options options={map.address,1024u,sizeof module};wasm_cut_report report;pl_u64 bytes=0u;
        int status=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report);
        if(status||law_checks(&image)||report.source_instructions!=1u||report.source_bytes!=length||report.memory_bytes!=(variant?2u:0u)
            ||report.flags_written||report.boundary!=WASM_CUT_SYSTEM){fprintf(stderr,"x87 snapshot form=%u status=%d\n",form,status);goto done;}
        for(pl_u32 row=0u;row<32u;++row){
            _Alignas(16) pl_u8 input[512]={0},before[512],after[512];
            put(input,0x340u|((row&3u)<<10u)|(row&63u),2u);put(input+2u,random_word(&seed),2u);input[4u]=(pl_u8)random_word(&seed);
            put(input+6u,random_word(&seed)&0x7ffu,2u);put(input+8u,0x12340000u+row,8u);put(input+16u,0x45670000u+row,8u);
            put(input+24u,0x1f80u,4u);
            for(pl_u32 i=0u;i<8u;++i){put(input+32u+i*16u,random_word(&seed),8u);put(input+40u+i*16u,random_word(&seed),2u);}
            for(pl_u32 i=0u;i<32u;++i)put(input+160u+i*8u,random_word(&seed),8u);
            machine_state *first=&records[row][0],*last=&records[row][1];memset(first,0,sizeof *first);
            for(pl_u32 r=0u;r<16u;++r)first->registers[r]=random_word(&seed);
            first->registers[7u]=(pl_u64)(uintptr_t)target;first->rip=map.address;first->rflags=0x202u|(random_word(&seed)&0xcd5u);
            first->cr0=0x80010031u;first->cr3=0x1000u;first->cr4=32u;first->efer=0xd00u;first->retired=42u;
            first->system[MACHINE_SYSTEM_CS]=19u;first->system[MACHINE_SYSTEM_DR0+6u]=0xffff0ff0u;
            first->system[MACHINE_SYSTEM_DR0+7u]=0x400u;*last=*first;memset(target,0xa5,8192u);
            native_fxsave(last,code,input,before,after);first->registers[4u]=last->registers[4u];
            check_x87_project(first,before);check_x87_project(last,after);words[row]=(pl_u16)check_x87_read(target,2u);
            pl_u16 expected=variant==2u?first->x87_control:first->x87_status;
            if(variant?words[row]!=expected:(last->registers[0]&0xffffu)!=expected)goto done;
            // Native GPR captures and architectural retirement are separate
            // from the complete unchanged FPU/vector observation.
            if(memcmp(first->xmm,last->xmm,sizeof first->xmm)||first->mxcsr!=last->mxcsr
                ||memcmp(first->x87_significand,last->x87_significand,
                    sizeof *first-(size_t)((pl_u8 *)first->x87_significand-(pl_u8 *)first)))goto done;
            last->rip+=length;++last->retired;++observations;
        }
        char json[256];int n=snprintf(json,sizeof json,"{\"entry\":\"4194304\",\"sourceBytes\":%u,\"stateBytes\":%zu,\"native\":32,\"memory\":%u,\"status\":%u}\n",length,sizeof(machine_state),variant!=0u,variant!=2u);
        if(n<1||(size_t)n>=sizeof json||save(directory,form,"json",json,(size_t)n)||save(directory,form,"wasm",module,(size_t)bytes)
            ||save(directory,form,"source-page",page,sizeof page)||save(directory,form,"cases",records,sizeof records)
            ||save(directory,form,"words",words,sizeof words))goto done;
    }
    const pl_u8 locked[][3]={{0xf0u,0xdfu,0xe0u},{0xf0u,0xddu,0x3fu},{0xf0u,0xd9u,0x3fu}};
    for(pl_u32 i=0u;i<3u;++i){memset(page,0x90,sizeof page);memcpy(page,locked[i],sizeof locked[i]);
        pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
        wasm_cut_options options={map.address,1u,sizeof module};if(check_fault_admission(&image,&options,6u))goto done;}
    failed=0;printf("x87 no-wait snapshots: %u native observations / 24 forms / 288 malformed descriptors / 3 architectural LOCK faults\n",observations);
done:
    if(munmap(code,4096u)||munmap(target,8192u))failed=1;
    return failed;
}
