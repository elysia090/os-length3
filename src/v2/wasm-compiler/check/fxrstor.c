#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include "fault-admission.h"
#include <machine/state.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>

extern void native_fxsave(machine_state *,const void *,const void *,void *,void *);
typedef struct { machine_state before,after; pl_u8 old_image[512],new_image[512]; } observation;
static observation records[64];
static pl_u8 page[4096],module[65536];
static pl_u64 random_word(pl_u64 *seed)
{ *seed^=*seed<<13u; *seed^=*seed>>7u; *seed^=*seed<<17u; return *seed; }
static void put(void *at,pl_u64 value,pl_u32 bytes)
{ for(pl_u32 i=0u;i<bytes;++i)((pl_u8 *)at)[i]=(pl_u8)(value>>(i*8u)); }
static pl_u64 get(const void *at,pl_u32 bytes)
{ pl_u64 value=0u; for(pl_u32 i=0u;i<bytes;++i)value|=(pl_u64)((const pl_u8 *)at)[i]<<(i*8u); return value; }
static void project(machine_state *cpu,const pl_u8 *image)
{
    cpu->x87_control=(pl_u16)get(image,2u); cpu->x87_status=(pl_u16)get(image+2u,2u);
    cpu->x87_opcode=(pl_u16)get(image+6u,2u); cpu->x87_ip=get(image+8u,8u); cpu->x87_dp=get(image+16u,8u);
    cpu->mxcsr=(pl_u32)get(image+24u,4u); cpu->x87_tag=0u;
    pl_u32 top=(cpu->x87_status>>11u)&7u;
    for(pl_u32 rank=0u;rank<8u;++rank) {
        pl_u32 logical=(rank+8u-top)&7u;
        pl_u64 fraction=get(image+32u+logical*16u,8u);
        pl_u16 sign_exponent=(pl_u16)get(image+40u+logical*16u,2u);
        pl_u32 exponent=sign_exponent&0x7fffu;
        pl_u32 tag=!(image[4u]&(1u<<rank)) ? 3u : !exponent && !fraction ? 1u
            : !exponent || exponent==0x7fffu || !(fraction>>63u) ? 2u : 0u;
        cpu->x87_tag=(pl_u16)(cpu->x87_tag|(tag<<(rank*2u)));
        cpu->x87_significand[rank]=fraction; cpu->x87_sign_exponent[rank]=sign_exponent;
    }
    memcpy(cpu->xmm,image+160u,sizeof cpu->xmm);
}
static int save(const char *directory,pl_u32 form,const char *suffix,const void *bytes,size_t count)
{
    if(!directory)return 0;
    char path[4096]; int n=snprintf(path,sizeof path,"%s/fxrstor-%u.%s",directory,form,suffix);
    if(n<1 || (size_t)n>=sizeof path)return -1;
    FILE *file=fopen(path,"wbx"); if(!file)return -1;
    int result=fwrite(bytes,1u,count,file)==count?0:-1; if(fclose(file))result=-1; return result;
}
static int boundaries(void)
{
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
    pl_x86_image image={&map,1u,0u,map.address}; wasm_cut_options options={map.address,8u,sizeof module};
    wasm_cut_report report; pl_u64 emitted=0u;
    memset(page,0x90,sizeof page); page[1u]=0x0fu; page[2u]=0xaeu; page[3u]=0x0fu;
    if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)
            || report.source_instructions!=1u || report.source_bytes!=1u || report.memory_bytes
            || report.continuation!=map.address+1u || report.boundary!=WASM_CUT_SYSTEM)return 0;
    ++options.entry;
    if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)
            || report.source_instructions!=1u || report.source_bytes!=3u || report.memory_bytes!=512u
            || report.continuation!=map.address+4u)return 0;
    static const pl_u8 refused[][4]={{0xf0u,0x0fu,0xaeu,0x0fu},
        {0x66u,0x0fu,0xaeu,0x0fu},{0xf3u,0x0fu,0xaeu,0x0fu},{0x0fu,0xaeu,0xc0u,0x90u}};
    options.entry=map.address;
    for(pl_u32 rank=0u;rank<sizeof refused/sizeof refused[0];++rank) {
        memcpy(page,refused[rank],sizeof refused[rank]);
        if(check_fault_admission(&image,&options,6u))return 0;
    }
    return 1;
}
int main(int argc,char **argv)
{
    int observe=argc==3 && !strcmp(argv[2],"--observe");
    if(argc!=1 && argc!=2 && !observe)return 2;
    pl_u8 *code=mmap(NULL,4096u,PROT_READ|PROT_WRITE|PROT_EXEC,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    pl_u8 *allocation=mmap(NULL,4u*1024u*1024u,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS|MAP_32BIT,-1,0);
    if(code==MAP_FAILED || allocation==MAP_FAILED)return 1;
    pl_u8 *target=(pl_u8 *)(((uintptr_t)allocation+0x1fffffu)&~(uintptr_t)0x1fffffu);
    static const pl_u8 source[][6]={
        {0x0fu,0xaeu,0x0fu},{0x48u,0x0fu,0xaeu,0x0fu},{0x0fu,0xaeu,0x4du,0x00u},
        {0x67u,0x0fu,0xaeu,0x0fu},{0x41u,0x0fu,0xaeu,0x08u},{0x49u,0x0fu,0xaeu,0x08u},
        {0x0fu,0xaeu,0x4fu,0x10u},{0x0fu,0xaeu,0x4cu,0x4fu,0x40u},
        {0x48u,0x0fu,0xaeu,0x4fu,0x40u}
    };
    static const pl_u32 lengths[]={3u,4u,4u,4u,4u,4u,4u,5u,5u};
    pl_u64 seed=0x8a1334479ccb0021ull; pl_u32 observations=0u; int result=1;
    for(pl_u32 form=0u;form<9u;++form) {
        memset(page,0x90,sizeof page); memcpy(page,source[form],lengths[form]);
        memcpy(code,page,sizeof page); code[lengths[form]]=0xc3u;
        pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,map.address}; wasm_cut_options options={map.address,8u,sizeof module};
        wasm_cut_report report; pl_u64 emitted=0u;
        for(pl_u32 row=0u;row<64u;++row) {
            observation *record=&records[row]; memset(record,0,sizeof *record);
            _Alignas(16) pl_u8 seed_image[512]={0},before[512],after[512];
            memset(before,0,sizeof before); memset(after,0,sizeof after);
            put(seed_image,0x340u|((row&3u)<<10u)|(row&63u),2u);
            put(seed_image+2u,(row&7u)<<11u|(row&63u),2u); seed_image[4u]=(pl_u8)(row*73u);
            put(seed_image+6u,random_word(&seed)&0x7ffu,2u);
            put(seed_image+8u,random_word(&seed),8u); put(seed_image+16u,random_word(&seed),8u);
            put(seed_image+24u,0x1f80u|((row&3u)<<13u),4u);
            for(pl_u32 rank=0u;rank<8u;++rank) {
                pl_u32 type=(rank+row)%6u;
                pl_u64 fraction=type==1u ? 0u : random_word(&seed)|(1ull<<63u);
                if(type==4u)fraction&=~(1ull<<63u);
                put(seed_image+32u+rank*16u,fraction,8u);
                put(seed_image+40u+rank*16u,type==1u || type==5u ? 0u : type==2u ? 0x7fffu : 0x3fffu,2u);
            }
            for(pl_u32 rank=0u;rank<32u;++rank)put(seed_image+160u+rank*8u,random_word(&seed),8u);
            pl_u32 at=row%2u ? 3840u : 64u; pl_u8 *output=target+at;
            memcpy(record->old_image,seed_image,512u);
            put(record->old_image,random_word(&seed)&0xffffu,2u);
            put(record->old_image+2u,((row+3u)&7u)<<11u|(row&63u)|(row&1u?0x8080u:0u),2u);
            put(record->old_image+6u,random_word(&seed)&0xffffu,2u);
            put(record->old_image+24u,random_word(&seed)&0xffffu,4u);
            record->old_image[4u]^=0x55u;
            put(record->old_image+8u,random_word(&seed),8u);
            put(record->old_image+16u,random_word(&seed),8u);
            for(pl_u32 i=160u;i<416u;++i)record->old_image[i]^=0x39u;
            for(pl_u32 i=416u;i<512u;++i)record->old_image[i]=(pl_u8)random_word(&seed);
            memcpy(output,record->old_image,512u);
            machine_state cpu={0};
            for(pl_u32 rank=0u;rank<16u;++rank)cpu.registers[rank]=random_word(&seed);
            cpu.registers[7u]=(pl_u64)(uintptr_t)output-(form==6u ? 16u : form==7u ? 80u : form==8u ? 64u : 0u);
            if(form==7u)cpu.registers[1u]=8u;
            cpu.registers[8u]=(pl_u64)(uintptr_t)output;
            if(form==2u)cpu.registers[5u]=(pl_u64)(uintptr_t)output;
            cpu.rflags=0x202u|(random_word(&seed)&0xcd5u);
            record->before=cpu;
            native_fxsave(&cpu,code,seed_image,before,after);
            record->before.registers[4u]=cpu.registers[4u];
            if(memcmp(record->before.registers,cpu.registers,sizeof cpu.registers)
                    || record->before.rflags!=cpu.rflags)goto done;
            project(&record->before,before);
            record->before.rip=map.address; record->before.cr0=0x80010011u;
            record->before.cr3=0x1000u; record->before.cr4=0x220u; record->before.efer=0xd00u;
            record->before.system[MACHINE_SYSTEM_CS]=19u;
            record->before.system[MACHINE_SYSTEM_DR0+6u]=0xffff0ff0u;
            record->before.system[MACHINE_SYSTEM_DR0+7u]=0x400u; record->before.retired=42u;
            record->after=record->before; project(&record->after,after);
            record->after.rip+=lengths[form]; ++record->after.retired;
            memcpy(record->new_image,output,512u);
            if(memcmp(record->old_image,record->new_image,512u))goto done;
            ++observations;
        }
        int status=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report);
        if(!observe && (status || report.source_instructions!=1u || report.source_bytes!=lengths[form] || report.memory_bytes!=512u)) {
            pl_x86_instruction instruction; int decoded=pl_x86_decode_profile(&image,map.address,&instruction);
            fprintf(stderr,"FXRSTOR form=%u compiler=%d decode=%d status=%u flow=%u machine=%u arg=%llx operands=%u bits=%u flags=%x\n",form,status,decoded,
                instruction.status,instruction.flow,instruction.machine_operation,(unsigned long long)instruction.machine_argument,
                instruction.visible_operand_count,instruction.operands[0].bits,instruction.flags); goto done;
        }
        char json[300]; int n=snprintf(json,sizeof json,"{\"entry\":\"4194304\",\"sourceBytes\":%u,\"instructions\":1,\"native\":64,\"stateBytes\":%zu,\"address\":\"%llu\"}\n",lengths[form],sizeof(machine_state),(unsigned long long)(uintptr_t)target);
        if(n<1 || (size_t)n>=sizeof json || save(argc>=2?argv[1]:NULL,form,"json",json,(size_t)n)
                || save(argc>=2?argv[1]:NULL,form,"source-page",page,sizeof page)
                || save(argc>=2?argv[1]:NULL,form,"cases",records,sizeof records)
                || (!observe && save(argc>=2?argv[1]:NULL,form,"wasm",module,(size_t)emitted)))goto done;
    }
    if(observe || boundaries())result=0;
done:
    if(munmap(code,4096u) || munmap(allocation,4u*1024u*1024u))result=1;
    if(!result)printf("FXRSTOR: %u native GPR/flags/FPU/512-byte image observations, all TOP and tag classes; no physical-hardware fault claim\n",observations);
    return result;
}
