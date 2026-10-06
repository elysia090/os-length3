#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <sys/mman.h>
#include <stdio.h>
#include <string.h>
extern void native_cut(machine_state *,const void *);
static pl_u8 page[4096],module[65536],previous[65536];
static int save(const char *directory,pl_u32 id,const char *suffix,const void *bytes,size_t size)
{
    if(!directory)return 0;
    char name[4096];int n=snprintf(name,sizeof name,"%s/literal-%u.%s",directory,id,suffix);
    if(n<1 || (size_t)n>=sizeof name)return 1;
    FILE *file=fopen(name,"wbx");if(!file)return 1;
    int error=fwrite(bytes,1u,size,file)!=size;if(fclose(file))error=1;return error;
}
int main(int argc,char **argv)
{
    if(argc>2)return 2;
    pl_u8 *code=mmap(NULL,4096,PROT_READ|PROT_WRITE|PROT_EXEC,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if(code==MAP_FAILED)return 1;
    pl_u32 id=0u,native=0u,shared=0u;int result=1;
    const pl_u64 values[]={0u,1u,127u,128u,255u,256u,32767u,32768u,65535u,65536u,
        0x7fffffffu,0x80000000u,0xffffffffu,0xffffffff80000000ull,~0ull,0x1234567887654321ull};
    for(pl_u32 bits=8u;bits<=64u;bits*=2u)for(pl_u32 legacy=0u;legacy<(bits==8u?2u:1u);++legacy)
    for(pl_u32 reg=0u;reg<(legacy?4u:16u);++reg){
        if(!legacy && reg==4u)continue; /* A return harness cannot write RSP. */
        pl_u64 previous_bytes=0u;int previous_kind=-1;
        for(pl_u32 rank=0u;rank<sizeof values/sizeof values[0];++rank,++id){
            memset(page,0xcc,sizeof page);pl_u32 n=0u;
            if(bits==16u)page[n++]=0x66u;
            if(!legacy && (bits==64u || reg>=8u || (bits==8u && reg>=4u)))
                page[n++]=(pl_u8)(0x40u|(bits==64u?8u:0u)|(reg>=8u));
            page[n++]=(pl_u8)((bits==8u?0xb0u:0xb8u)+(legacy?reg+4u:reg&7u));
            pl_u64 value=values[rank];if(bits<64u)value&=(1ull<<bits)-1u;
            for(pl_u32 byte=0u;byte<bits/8u;++byte)page[n++]=(pl_u8)(value>>(byte*8u));
            page[n]=0xc3u;memcpy(code,page,sizeof page);
            pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
            wasm_cut_options options={map.address,1u,sizeof module};wasm_cut_report report;pl_u64 bytes=0u;
            if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report))goto done;
            int kind=value<=0xffffffffu?0:value>=0xffffffff80000000ull?1:2;
            if(report.source_instructions!=1u || report.source_bytes!=n || report.flags_written || report.memory_bytes
                    || report.operand_binding!=(kind==2?0u:(pl_u32)value)){
                fprintf(stderr,"literal binding red bits=%u reg=%u value=%llx\n",bits,reg,value);goto done;
            }
            if(kind<2 && previous_kind==kind){
                if(previous_bytes!=bytes || memcmp(previous,module,(size_t)bytes)){
                    fprintf(stderr,"literal topology red bits=%u reg=%u\n",bits,reg);goto done;
                }
                ++shared;
            }
            memcpy(previous,module,(size_t)bytes);previous_bytes=bytes;previous_kind=kind;
            machine_state records[2]={0};
            for(pl_u32 r=0u;r<16u;++r)records[0].registers[r]=0xabcdeffedcba0000ull+(pl_u64)r*31337u;
            records[0].rflags=0x202u|(values[rank]&0x8d5u);records[1]=records[0];
            native_cut(&records[1],code);records[0].registers[4]=records[1].registers[4];
            pl_u64 mask=bits==64u?~0ull:(1ull<<bits)-1u,shift=legacy?8u:0u;
            pl_u64 expected=(bits>=32u?0u:records[0].registers[reg]&~(mask<<shift))|(value<<shift);
            for(pl_u32 r=0u;r<16u;++r)if(records[1].registers[r]!=(r==reg?expected:records[0].registers[r]))goto done;
            if(records[0].rflags!=records[1].rflags)goto done;
            ++native;
            if(argc==2){
                char json[256];int count=snprintf(json,sizeof json,"{\"sourceBytes\":%u,\"binding\":%u,\"bits\":%u,\"reg\":%u,\"legacy\":%u,\"kind\":%u}\n",n,report.operand_binding,bits,reg,legacy,(unsigned)kind);
                if(count<1 || (size_t)count>=sizeof json || save(argv[1],id,"json",json,(size_t)count)
                        ||save(argv[1],id,"wasm",module,(size_t)bytes)||save(argv[1],id,"source-page",page,sizeof page)
                        ||save(argv[1],id,"cases",records,sizeof records))goto done;
            }
        }
    }
    printf("Literal binding: %u native GPR/full-flags receipts, %u shared topology pairs; RSP writes excluded from native harness\n",native,shared);result=0;
done:
    if(munmap(code,4096))result=1;
    return result;
}
