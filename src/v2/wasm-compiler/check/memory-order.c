/* Native register/FPU observations do not prove concurrent memory ordering.
 * The compiler's ordering contract is synchronous, single-owner ordinary RAM. */
#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include "fault-admission.h"
#include <machine/state.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>

extern void native_vector(const machine_state *,const void *,const void *,void *,void *);
extern void native_stack_capture(void);
extern pl_u64 native_stack_result[17];
typedef struct { machine_state before,after; } observation;
enum { FORMS=120, SAMPLES=64 };
static observation records[SAMPLES];
static pl_u8 source[4096],module[65536];
static pl_u64 random_word(pl_u64 *seed)
{ *seed^=*seed<<13u; *seed^=*seed>>7u; *seed^=*seed<<17u; return *seed; }
static void put(void *target,pl_u64 value,pl_u32 bytes)
{ for(pl_u32 i=0u;i<bytes;++i)((pl_u8 *)target)[i]=(pl_u8)(value>>(8u*i)); }
static pl_u32 encoding(pl_u32 form)
{
    static const pl_u8 prefixes[]={0u,0x67u,0x48u,0x64u,0x65u};
    pl_u32 kind=form/40u,prefix=form/8u%5u,at=0u;
    if(prefixes[prefix])source[at++]=prefixes[prefix];
    source[at++]=0x0fu;source[at++]=0xaeu;
    source[at++]=(pl_u8)((kind==0u?0xe8u:kind==1u?0xf0u:0xf8u)|(form%8u));
    return at;
}
static int save(const char *directory,pl_u32 form,const char *suffix,const void *data,size_t bytes)
{
    if(!directory)return 0;
    char name[4096];int n=snprintf(name,sizeof name,"%s/memory-order-%u.%s",directory,form,suffix);
    if(n<1 || (size_t)n>=sizeof name)return -1;
    FILE *file=fopen(name,"wbx");if(!file)return -1;
    int status=fwrite(data,1u,bytes,file)==bytes?0:-1;if(fclose(file))status=-1;return status;
}
static int compile(pl_x86_image *image,wasm_cut_options *options,pl_u32 size,pl_u64 *emitted)
{
    wasm_cut_report report;
    int status=wasm_compiler_emit_code_cut(image,9u,options,module,sizeof module,emitted,&report);
    if(status || report.source_instructions!=1u || report.source_bytes!=size
            || report.continuation!=options->entry+size || report.boundary!=WASM_CUT_SYSTEM
            || report.memory_bytes || report.memory_access || report.read_registers
            || report.written_registers || report.flags_written) {
        fprintf(stderr,"memory order red: compiler=%d, entry=%llx\n",status,options->entry);return -1;
    }
    return 0;
}
static int admission(void)
{
    pl_u8 pages[8192];
    pl_x86_map maps[2]={{pages,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u},
        {pages+4096u,0x401000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u}};
    pl_x86_image image={maps,2u,0u,maps[0].address};
    wasm_cut_options options={image.entry,1024u,sizeof module};
    for(pl_u32 form=0u;form<FORMS;++form) {
        memset(source,0x90,sizeof source);pl_u32 size=encoding(form);pl_u64 emitted=0u;
        /* The preceding pure instruction must retire before the fence. */
        memset(pages,0x90,sizeof pages);memcpy(pages+1u,source,size);
        wasm_cut_report report;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)
                || report.source_bytes!=1u || report.source_instructions!=1u)return -1;
        options.entry=image.entry+1u;
        if(compile(&image,&options,size,&emitted))return -1;
        /* An instruction crossing a fetch page occupies its own cut. */
        memcpy(pages+4095u,source,size);options.entry=image.entry+4095u;
        if(compile(&image,&options,size,&emitted))return -1;
        options.entry=image.entry;
    }
    static const pl_u8 refused[][5]={
        {0xf0u,0x0fu,0xaeu,0xe8u}, {0xf0u,0x0fu,0xaeu,0xf0u}, {0xf0u,0x0fu,0xaeu,0xf8u},
        {0x0fu,0x09u}, {0x0fu,0x08u}, {0x0fu,0x01u,0xe8u}, /* WBINVD/INVD/SERIALIZE */
        {0x0fu,0xaeu,0x3fu}, {0x66u,0x0fu,0xaeu,0x37u}, /* CLFLUSH/CLWB memory */
        {0x66u,0x0fu,0xaeu,0xe8u}, {0x66u,0x0fu,0xaeu,0xf0u}, {0x66u,0x0fu,0xaeu,0xf8u},
        {0xf3u,0x0fu,0xaeu,0xe8u}, {0xf3u,0x0fu,0xaeu,0xf0u}, {0xf3u,0x0fu,0xaeu,0xf8u}
    };
    for(pl_u32 i=0u;i<sizeof refused/sizeof refused[0];++i) {
        memset(pages,0x90,sizeof pages);memcpy(pages,refused[i],sizeof refused[i]);
        if(i==3u||i==4u){pl_u64 emitted=0u;if(compile(&image,&options,2u,&emitted))return -1;continue;}
        if(i<=2u || i==8u || i==9u || i>=11u){if(check_fault_admission(&image,&options,6u))return -1;continue;}
        memset(module,0xa5,sizeof module);wasm_cut_report report;memset(&report,0xa5,sizeof report);
        wasm_cut_report before=report;pl_u64 emitted=77u;
        int status=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report);
        if(status!=WASM_COMPILER_ERROR_GRAMMAR || emitted!=77u || memcmp(&report,&before,sizeof report)){
            fprintf(stderr,"memory-order negative row=%u status=%d boundary=%u\n",i,status,report.boundary);return -1;
        }
        for(pl_u32 j=0u;j<sizeof module;++j)if(module[j]!=0xa5u)return -1;
    }
    return 0;
}
int main(int argc,char **argv)
{
    int observe_only=argc==3 && !strcmp(argv[2],"--observe");
    if(argc!=1 && argc!=2 && !observe_only)return 2;
    const char *directory=argc>=2?argv[1]:NULL;
    pl_u8 *code=mmap((void *)(uintptr_t)0x400000u,4096u,PROT_READ|PROT_WRITE|PROT_EXEC,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    pl_u8 *stack=mmap(NULL,4096u,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if(code==MAP_FAILED || stack==MAP_FAILED)return 1;
    pl_u64 seed=0x874425003377aa21ull;int status=1;
    for(pl_u32 form=0u;form<FORMS;++form) {
        memset(source,0x90,sizeof source);pl_u32 size=encoding(form);
        memcpy(code,source,sizeof source);code[size]=0xffu;code[size+1u]=0x25u;
        put(code+size+2u,0u,4u);put(code+size+6u,(pl_u64)(uintptr_t)native_stack_capture,8u);
        for(pl_u32 row=0u;row<SAMPLES;++row) {
            observation *r=&records[row];memset(r,0,sizeof *r);machine_state *state=&r->before;
            for(pl_u32 reg=0u;reg<16u;++reg)state->registers[reg]=random_word(&seed);
            state->registers[4u]=(pl_u64)(uintptr_t)(stack+2048u);
            state->rflags=0x202u|(random_word(&seed)&0xcd5u);
            _Alignas(16) pl_u8 host[512],initial[512],before[512]={0},after[512]={0};
            __asm__ volatile("fxsave64 %0":"=m"(host));memcpy(initial,host,sizeof initial);
            put(initial+24u,0x1f80u|(row&63u),4u);
            for(pl_u32 i=0u;i<32u;++i)put(initial+160u+i*8u,random_word(&seed),8u);
            native_vector(state,code,initial,before,after);
            __asm__ volatile("fxrstor64 %0"::"m"(host):"memory");
            if(memcmp(before,after,416u)) {fprintf(stderr,"fence FPU changed %u/%u\n",form,row);goto finish;}
            if(memcmp(state->registers,native_stack_result,128u) || state->rflags!=native_stack_result[16u]) {
                fprintf(stderr,"fence GPR/flags changed %u/%u\n",form,row);goto finish;
            }
            memcpy(state->xmm,before+160u,sizeof state->xmm);memcpy(&state->mxcsr,before+24u,4u);
            for(pl_u32 i=0u;i<8u;++i) {
                memcpy(&state->x87_significand[i],before+32u+i*16u,8u);
                memcpy(&state->x87_sign_exponent[i],before+40u+i*16u,2u);
            }
            memcpy(&state->x87_control,before,2u);memcpy(&state->x87_status,before+2u,2u);
            state->x87_tag=before[4u];memcpy(&state->x87_opcode,before+6u,2u);
            memcpy(&state->x87_ip,before+8u,8u);memcpy(&state->x87_dp,before+16u,8u);
            state->rip=0x400000u;state->cr0=0x80010011u;state->cr3=0x1000u;
            state->cr4=0x220u;state->efer=0xd00u;state->system[MACHINE_SYSTEM_CS]=19u;
            state->system[MACHINE_SYSTEM_DR0+6u]=0xffff0ff0u;state->system[MACHINE_SYSTEM_DR0+7u]=0x400u;
            state->retired=42u;state->work=17u;state->span=13u;
            r->after=*state;memcpy(r->after.registers,native_stack_result,128u);
            r->after.rflags=native_stack_result[16u];r->after.rip+=size;r->after.retired++;
            /* RSP is an unrelated caller allocation, not a fence operand. Store
             * a fixed coordinate after the native equality check for replay. */
            r->before.registers[4u]=r->after.registers[4u]=0x12340800u;
        }
        pl_u64 emitted=0u;
        if(!observe_only) {
            pl_x86_map map={source,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
            pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={image.entry,1024u,sizeof module};
            if(compile(&image,&options,size,&emitted))goto finish;
        }
        char json[512];int n=snprintf(json,sizeof json,
            "{\"entry\":\"4194304\",\"sourceBytes\":%u,\"kind\":%u,\"native\":%u,\"stateBytes\":%zu,\"recordBytes\":%zu,\"moduleBytes\":%llu}\n",
            size,form/40u,SAMPLES,sizeof(machine_state),sizeof(observation),emitted);
        if(n<1 || (size_t)n>=sizeof json || save(directory,form,"json",json,(size_t)n)
                || save(directory,form,"source-page",source,sizeof source)
                || save(directory,form,"cases",records,sizeof records)
                || (!observe_only && save(directory,form,"wasm",module,(size_t)emitted)))goto finish;
    }
    if(!observe_only && admission())goto finish;
    status=0;
finish:
    if(munmap(code,4096u) || munmap(stack,4096u))status=1;
    if(!status)printf("Fences: %u native GPR/flags/FPU observations; %u forms; not SMP ordering or Linux boot%s\n",
        FORMS*SAMPLES,FORMS,observe_only?"; lowering not tested":"");
    return status;
}
