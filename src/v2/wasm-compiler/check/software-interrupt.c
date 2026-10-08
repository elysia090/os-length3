#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include "fault-admission.h"
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096], output[65536];
static unsigned failures;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr,"software interrupt: line %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static int save(const char *directory,unsigned rank,const char *suffix,const void *data,size_t size)
{
    if(!directory)return 0;
    char name[4096];int n=snprintf(name,sizeof name,"%s/software-interrupt-%u.%s",directory,rank,suffix);
    if(n<=0 || (size_t)n>=sizeof name)return -1;
    FILE *file=fopen(name,"wbx");if(!file)return -1;
    int result=fwrite(data,1u,size,file)==size?0:-1;
    if(fclose(file))result=-1;
    return result;
}
int main(int argc,char **argv)
{
    if(argc!=1 && argc!=2)return 2;
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
    pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={map.address,8u,sizeof output};
    static const pl_u8 forms[][3]={{0xccu},{0x66u,0xccu},{0x67u,0xccu},{0x48u,0xccu},
        {0x64u,0xccu},{0x65u,0xccu},{0xf2u,0xccu},{0xf3u,0xccu}};
    for(unsigned rank=0u;rank<16u;++rank) {
        unsigned form=rank&7u,vector=rank<8u?3u:1u;
        memset(page,0x90,sizeof page);unsigned length=form?2u:1u;memcpy(page,forms[form],length);
        page[length-1u]=(pl_u8)(vector==1u?0xf1u:0xccu);
        pl_x86_instruction instruction;pl_x86_software_trap law;
        EXPECT(!pl_x86_decode_profile(&image,map.address,&instruction));
        EXPECT(pl_x86_software_trap_lower(&instruction,&law)&&law.vector==vector&&law.bytes==length);
        pl_u64 emitted=0u;wasm_cut_report report;
        int status=wasm_compiler_emit_code_cut(&image,9u,&options,output,sizeof output,&emitted,&report);
        EXPECT(!status);
        if(status)continue;
        EXPECT(report.source_instructions==1u && report.source_bytes==length
            && report.continuation==map.address+length && report.boundary==WASM_CUT_CONTROL
            && !report.memory_bytes && !report.read_registers && !report.written_registers && report.flags_written);
        char json[160];int n=snprintf(json,sizeof json,"{\"entry\":\"4194304\",\"sourceBytes\":%u,\"instructions\":1,\"vector\":%u}\n",length,vector);
        if(n<=0 || (size_t)n>=sizeof json || save(argc==2?argv[1]:NULL,rank,"json",json,(size_t)n)
            || save(argc==2?argv[1]:NULL,rank,"source-page",page,sizeof page)
            || save(argc==2?argv[1]:NULL,rank,"wasm",output,(size_t)emitted))return 1;
        for(unsigned bad=0u;bad<12u;++bad){pl_x86_instruction changed=instruction;
            switch(bad){case 0:changed.machine_argument|=1ull<<32u;break;case 1:changed.trap_vector^=2u;break;
            case 2:changed.flags&=~PL_X86_INSTRUCTION_TRAP_AFTER;break;case 3:changed.visible_operand_count=1u;break;
            case 4:changed.length=0u;break;case 5:changed.flags|=PL_X86_INSTRUCTION_PRIVILEGED;break;
            case 6:changed.flags|=PL_X86_INSTRUCTION_WRITES_MEMORY;break;case 7:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;
            case 8:changed.flow=PL_X86_FLOW_SYSTEM;break;case 9:changed.status=PL_X86_DECODE_INVALID;break;
            case 10:changed.opcode=0xcdu;break;default:++changed.source_bytes;break;}
            pl_x86_software_trap value,old;memset(&old,0xa5,sizeof old);value=old;
            EXPECT(!pl_x86_software_trap_lower(&changed,&value)&&!memcmp(&value,&old,sizeof old));
            pl_u8 scratch[8192];pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;
            EXPECT(pl_x86_lower(&changed,&arena,&semantic)==PL_ERROR_X86_SEMANTIC);}
    }
    memset(page,0x90,sizeof page);page[1u]=0xccu;
    pl_u64 emitted=0u;wasm_cut_report report;
    EXPECT(!wasm_compiler_emit_code_cut(&image,9u,&options,output,sizeof output,&emitted,&report));
    EXPECT(report.source_instructions==1u && report.source_bytes==1u && report.continuation==map.address+1u);
    /* LOCK explicit traps/HLT are #UD, not compiler grammar failures. INT n still
     * require their own precise machine laws and refuse immutably. */
    static const pl_u8 refused[][3]={{0xf0u,0xccu},{0xcdu,3u},{0xcdu,1u},{0xf0u,0xf4u},{0xf0u,0xf1u}};
    for(unsigned rank=0u;rank<5u;++rank) {
        memcpy(page,refused[rank],sizeof refused[rank]);memset(output,0xa5,sizeof output);
        if(rank==0u || rank==3u || rank==4u){EXPECT(!check_fault_admission(&image,&options,6u));continue;}
        memset(&report,0xa5,sizeof report);wasm_cut_report before=report;emitted=77u;
        EXPECT(wasm_compiler_emit_code_cut(&image,9u,&options,output,sizeof output,&emitted,&report)==WASM_COMPILER_ERROR_GRAMMAR);
        EXPECT(emitted==77u && !memcmp(&before,&report,sizeof report));
        for(unsigned i=0u;i<sizeof output;++i)EXPECT(output[i]==0xa5u);
    }
    if(failures)return 1;
    puts("INT1/INT3: 16 common C forms, 192 malformed laws, precise prefix and unchanged refusals; runtime oracle separate");return 0;
}
