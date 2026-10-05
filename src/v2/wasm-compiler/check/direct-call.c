#define _GNU_SOURCE
/* Real native CALL to the sole valid trampoline in each executable page.
 * Only canonical successful targets: unresolved noncanonical-target fault
 * publication remains a separate strict system-oracle obligation. */
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
extern void native_stack_cut(const machine_state *,const void *);
extern void native_stack_capture(void);
extern pl_u64 native_stack_result[17];
static pl_u8 page[4096],module[65536];
static pl_u64 random_word(pl_u64 *seed)
{*seed^=*seed<<13u;*seed^=*seed>>7u;*seed^=*seed<<17u;return *seed;}
static void put(pl_u8 *target,pl_u64 value,pl_u32 bytes)
{for(pl_u32 i=0u;i<bytes;++i)target[i]=(pl_u8)(value>>(i*8u));}
static int save(const char *directory,unsigned form,const char *suffix,const void *bytes,size_t size)
{
    if(!directory)return 0;
    char path[4096];int n=snprintf(path,sizeof path,"%s/direct-call-%u.%s",directory,form,suffix);
    if(n<1||(size_t)n>=sizeof path)return -1;
    FILE *file=fopen(path,"wbx");if(!file)return -1;
    int status=fwrite(bytes,1u,size,file)==size?0:-1;if(fclose(file))status=-1;return status;
}
int main(int argc,char **argv)
{
    if(argc!=1&&argc!=2)return 2;
    pl_u8 *code=mmap((void *)(uintptr_t)0x400000u,4096u,PROT_READ|PROT_WRITE|PROT_EXEC,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    pl_u8 *ram=mmap((void *)(uintptr_t)0x12340000u,8192u,PROT_READ|PROT_WRITE,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    int result=1;if(code==MAP_FAILED||ram==MAP_FAILED)goto finish;
    pl_u64 seed=0xcabbe0ddbeef0193ull;pl_u32 targets[]={0x100u,0x300u,0x700u,0x900u,0xff0u};
    for(unsigned form=0u;form<30u;++form){
        pl_u32 prefix=form%3u,start=form/15u?0x800u:0u,target=targets[form/3u%5u];
        pl_u32 length=prefix?6u:5u;pl_u64 entry=0x400000u+start;
        pl_u32 displacement=(pl_u32)(target-start-length);
        memset(page,0xcc,sizeof page);pl_u32 at=start;
        if(prefix)page[at++]=prefix==1u?0x67u:0x48u;
        page[at++]=0xe8u;put(page+at,displacement,4u);
        page[target]=0xffu;page[target+1u]=0x25u;put(page+target+2u,0u,4u);
        put(page+target+6u,(pl_u64)(uintptr_t)native_stack_capture,8u);memcpy(code,page,sizeof page);
        pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,entry};wasm_cut_options options={entry,1u,sizeof module};
        wasm_cut_report report;pl_u64 bytes=0u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)
                || report.source_instructions!=1u || report.source_bytes!=length || report.memory_bytes!=8u
                || report.boundary!=WASM_CUT_CONTROL || report.operand_binding!=displacement)goto finish;
        pl_u64 records[128][38];
        for(pl_u32 row=0u;row<128u;++row){
            machine_state state={0};for(pl_u32 reg=0u;reg<16u;++reg)state.registers[reg]=random_word(&seed);
            state.registers[4]=0x12340000u+(row%3u==0u?4101u:row%3u==1u?4104u:4088u);
            state.rflags=0x202u|(random_word(&seed)&0xcd5u);state.rip=entry;
            memset(ram,0x93,8192u);native_stack_cut(&state,code+start);
            for(pl_u32 reg=0u;reg<16u;++reg){
                pl_u64 wanted=state.registers[reg]-(reg==4u?8u:0u);
                if(native_stack_result[reg]!=wanted)goto finish;
                records[row][reg]=state.registers[reg];records[row][17u+reg]=native_stack_result[reg];
            }
            if(native_stack_result[16]!=state.rflags)goto finish;
            pl_u64 stored;pl_u32 offset=(pl_u32)(state.registers[4]-0x12340000u-8u);
            memcpy(&stored,ram+offset,8u);if(stored!=entry+length)goto finish;
            for(pl_u32 index=0u;index<8192u;++index)
                if((index<offset||index>=offset+8u)&&ram[index]!=0x93u)goto finish;
            records[row][16]=state.rflags;records[row][33]=native_stack_result[16];
            records[row][34]=state.registers[4]-8u;records[row][35]=stored;
            records[row][36]=entry;records[row][37]=0x400000u+target;
        }
        char json[256];int n=snprintf(json,sizeof json,
            "{\"entry\":%llu,\"sourceBytes\":%u,\"operandBinding\":%u,\"rows\":128,\"words\":38}\n",entry,length,displacement);
        if(n<1||(size_t)n>=sizeof json || save(argc==2?argv[1]:NULL,form,"json",json,(size_t)n)
                ||save(argc==2?argv[1]:NULL,form,"source-page",page,sizeof page)
                ||save(argc==2?argv[1]:NULL,form,"wasm",module,(size_t)bytes)
                ||save(argc==2?argv[1]:NULL,form,"cases",records,sizeof records))goto finish;
    }
    puts("Direct CALL: 3840 native GPR/flags/return-word observations, 30 precise bound C emissions");result=0;
finish:
    if(code!=MAP_FAILED&&munmap(code,4096u))result=1;
    if(ram!=MAP_FAILED&&munmap(ram,8192u))result=1;
    return result;
}
