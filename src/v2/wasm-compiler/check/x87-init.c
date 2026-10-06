#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include "fault-admission.h"
#include <machine/state.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>

extern void native_cut(machine_state *, const void *);
static pl_u8 page[4096], module[65536];
static machine_state records[256][2];
static pl_u64 random_word(pl_u64 *seed)
{ *seed^=*seed<<13u; *seed^=*seed>>7u; *seed^=*seed<<17u; return *seed; }
static void put(void *bytes, pl_u64 value, pl_u32 count)
{ for(pl_u32 i=0u;i<count;++i)((pl_u8 *)bytes)[i]=(pl_u8)(value>>(i*8u)); }
static pl_u64 get(const void *bytes, pl_u32 count)
{ pl_u64 value=0u; for(pl_u32 i=0u;i<count;++i)value|=(pl_u64)((const pl_u8 *)bytes)[i]<<(i*8u); return value; }
static void project(machine_state *state, const pl_u8 *image)
{
    state->x87_control=(pl_u16)get(image,2u); state->x87_status=(pl_u16)get(image+2u,2u);
    state->x87_tag=image[4u]?0u:0xffffu;
    state->x87_opcode=(pl_u16)get(image+6u,2u);
    state->x87_ip=get(image+8u,8u); state->x87_dp=get(image+16u,8u);
    state->mxcsr=(pl_u32)get(image+24u,4u);
    for(pl_u32 i=0u;i<8u;++i){
        state->x87_significand[i]=get(image+32u+i*16u,8u);
        state->x87_sign_exponent[i]=(pl_u16)get(image+40u+i*16u,2u);
    }
    memcpy(state->xmm,image+160u,sizeof state->xmm);
}
static int save(const char *directory, pl_u32 form, const char *suffix, const void *bytes, size_t count)
{
    if(!directory)return 0;
    char path[4096]; int n=snprintf(path,sizeof path,"%s/x87-init-%u.%s",directory,form,suffix);
    if(n<1 || (size_t)n>=sizeof path)return -1;
    FILE *file=fopen(path,"wbx"); if(!file)return -1;
    int result=fwrite(bytes,1u,count,file)==count?0:-1;
    if(fclose(file))result=-1;
    return result;
}
static int boundaries(void)
{
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
    pl_x86_image image={&map,1u,0u,map.address};
    wasm_cut_options options={map.address,8u,sizeof module}; wasm_cut_report report; pl_u64 emitted=0u;
    memset(page,0x90,sizeof page); page[1u]=0xdbu; page[2u]=0xe3u;
    if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)
            || report.source_instructions!=1u || report.source_bytes!=1u
            || report.continuation!=map.address+1u || report.boundary!=WASM_CUT_SYSTEM)return 0;
    ++options.entry;
    if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)
            || report.source_instructions!=1u || report.source_bytes!=2u
            || report.continuation!=map.address+3u || report.boundary!=WASM_CUT_SYSTEM)return 0;
    static const pl_u8 invalid[][3]={{0xf0u,0xdbu,0xe3u},{0x9bu,0xdbu,0xe3u},{0xdbu,0xe2u,0x90u}};
    options.entry=map.address;
    for(pl_u32 row=0u;row<sizeof invalid/sizeof invalid[0];++row){
        memcpy(page,invalid[row],sizeof invalid[row]); memset(module,0xa5,sizeof module);
        if(row==0u){if(check_fault_admission(&image,&options,6u))return 0;continue;}
        memset(&report,0xa5,sizeof report); wasm_cut_report before=report; emitted=77u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)
                !=WASM_COMPILER_ERROR_GRAMMAR || emitted!=77u || memcmp(&before,&report,sizeof report))return 0;
        for(pl_u32 i=0u;i<sizeof module;++i)if(module[i]!=0xa5u)return 0;
    }
    return 1;
}
int main(int argc, char **argv)
{
    if(argc!=1 && argc!=2)return 2;
    const char *directory=argc==2?argv[1]:NULL;
    pl_u8 *code=mmap(NULL,4096u,PROT_READ|PROT_WRITE|PROT_EXEC,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if(code==MAP_FAILED)return 1;
    static const pl_u8 prefixes[][2]={{0u,0u},{0x66u,0u},{0x67u,0u},{0x48u,0u},{0x64u,0u},{0x67u,0x64u},{0xf2u,0u},{0xf3u,0u}};
    pl_u64 seed=0x845699cca011aa27ull; pl_u32 observations=0u; int result=1;
    for(pl_u32 form=0u;form<sizeof prefixes/sizeof prefixes[0];++form){
        memset(page,0x90,sizeof page); pl_u32 length=0u;
        for(pl_u32 i=0u;i<2u && prefixes[form][i];++i)page[length++]=prefixes[form][i];
        page[length++]=0xdbu; page[length++]=0xe3u;
        memcpy(code,page,sizeof page); code[length]=0xc3u;
        pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,map.address};
        wasm_cut_options options={map.address,8u,sizeof module}; wasm_cut_report report; pl_u64 emitted=0u;
        int status=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report);
        if(status || report.source_instructions!=1u || report.source_bytes!=length || report.memory_bytes || report.flags_written){
            fprintf(stderr,"FNINIT form=%u compiler=%d\n",form,status); goto finished;
        }
        for(pl_u32 row=0u;row<256u;++row){
            _Alignas(16) pl_u8 host[512], input[512]={0}, before[512], after[512];
            put(input,0x340u|((row&3u)<<10u)|(row&63u),2u);
            // All eight physical registers are finite/nonempty; TOP=0 keeps
            // the FXSAVE logical ordering equal to physical register rank.
            put(input+2u,random_word(&seed)&~0x3800ull,2u); input[4u]=255u;
            put(input+6u,random_word(&seed)&0x7ffu,2u);
            put(input+8u,0x12340000u+row,8u); put(input+16u,0x56780000u+row,8u);
            put(input+24u,0x1f80u|((row&3u)<<13u),4u);
            for(pl_u32 rank=0u;rank<8u;++rank){
                put(input+32u+rank*16u,random_word(&seed)|(1ull<<63u),8u);
                put(input+40u+rank*16u,0x3fffu|(row&1u?0x8000u:0u),2u);
            }
            for(pl_u32 rank=0u;rank<32u;++rank)put(input+160u+rank*8u,random_word(&seed),8u);
            __asm__ volatile("fxsave64 %[host]\n\tfxrstor64 %[input]\n\tfxsave64 %[before]\n\tcall *%[code]\n\tfxsave64 %[after]\n\tfxrstor64 %[host]"
                :[host]"=m"(host),[before]"=m"(before),[after]"=m"(after)
                :[input]"m"(input),[code]"r"(code):"memory");
            if(before[4u]!=255u || after[4u] || get(after,2u)!=0x37fu || get(after+2u,2u)
                    || get(after+6u,2u) || get(after+8u,8u) || get(after+16u,8u)
                    || get(before+24u,4u)!=get(after+24u,4u)
                    || memcmp(before+160u,after+160u,256u))goto finished;
            for(pl_u32 rank=0u;rank<8u;++rank)
                if(memcmp(before+32u+rank*16u,after+32u+rank*16u,10u))goto finished;
            machine_state *first=&records[row][0], *last=&records[row][1];
            memset(first,0,sizeof *first);
            for(pl_u32 rank=0u;rank<16u;++rank)first->registers[rank]=random_word(&seed);
            first->rip=map.address; first->rflags=0x202u|(random_word(&seed)&0xcd5u);
            first->cr0=0x80010011u; first->cr3=0x1000u; first->cr4=32u; first->efer=0xd00u;
            first->system[MACHINE_SYSTEM_CS]=19u; first->system[MACHINE_SYSTEM_DR0+6u]=0xffff0ff0u;
            first->system[MACHINE_SYSTEM_DR0+7u]=0x400u; first->retired=42u;
            project(first,before);
            _Alignas(16) pl_u8 integer_host[512]; machine_state integer=*first;
            __asm__ volatile("fxsave64 %0":"=m"(integer_host));
            native_cut(&integer,code);
            __asm__ volatile("fxrstor64 %0"::"m"(integer_host):"memory");
            first->registers[4u]=integer.registers[4u];
            if(memcmp(first->registers,integer.registers,sizeof first->registers)
                    || first->rflags!=integer.rflags)goto finished;
            *last=*first; project(last,after);
            last->rip+=length; ++last->retired; ++observations;
        }
        char json[256]; int n=snprintf(json,sizeof json,"{\"entry\":\"4194304\",\"sourceBytes\":%u,\"instructions\":1,\"native\":256,\"stateBytes\":%zu}\n",length,sizeof(machine_state));
        if(n<1 || (size_t)n>=sizeof json || save(directory,form,"json",json,(size_t)n)
                || save(directory,form,"source-page",page,sizeof page)
                || save(directory,form,"cases",records,sizeof records)
                || save(directory,form,"wasm",module,(size_t)emitted))goto finished;
    }
    if(boundaries())result=0;
finished:
    if(munmap(code,4096u))result=1;
    if(!result)printf("FNINIT: %u actual x86 GPR/flags/x87/XMM/MXCSR observations; CR0 faults require system/model checks\n",observations);
    return result;
}
