#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <sys/mman.h>
#include <stdio.h>
#include <string.h>
extern void native_cut(machine_state *,const void *);
static pl_u8 page[4096],module[65536];
static machine_state records[64][2];
static pl_u64 random_word(pl_u64 *seed)
{*seed^=*seed<<13u;*seed^=*seed>>7u;*seed^=*seed<<17u;return *seed;}
static int save(const char *directory,pl_u32 form,const char *suffix,const void *bytes,size_t count)
{
    if(!directory)return 0;
    char path[4096];int n=snprintf(path,sizeof path,"%s/update-%u.%s",directory,form,suffix);
    if(n<1 || (size_t)n>=sizeof path)return -1;
    FILE *file=fopen(path,"wbx");if(!file)return -1;
    int status=fwrite(bytes,1u,count,file)==count?0:-1;
    if(fclose(file))status=-1;
    return status;
}
static pl_u64 mask(pl_u32 bits){return bits==64u?~0ull:(1ull<<bits)-1u;}
static pl_u64 read_lane(const machine_state *cpu,pl_u32 reg,pl_u32 bits,pl_u32 legacy)
{return (cpu->registers[legacy && reg>=4u?reg-4u:reg]>>(legacy && reg>=4u?8u:0u))&mask(bits);}
static void write_lane(machine_state *cpu,pl_u32 reg,pl_u32 bits,pl_u32 legacy,pl_u64 value)
{
    pl_u32 index=legacy && reg>=4u?reg-4u:reg,shift=legacy && reg>=4u?8u:0u;
    pl_u64 kept=bits>=32u?0u:cpu->registers[index]&~(mask(bits)<<shift);
    cpu->registers[index]=kept|((value&mask(bits))<<shift);
}
static pl_u32 encode(pl_u8 *bytes,pl_u32 compare,pl_u32 bits,pl_u32 dst,pl_u32 src,pl_u32 legacy)
{
    pl_u32 n=0u;if(bits==16u)bytes[n++]=0x66u;
    pl_u32 rex=(bits==64u?8u:0u)|(dst>=8u?1u:0u)|(src>=8u?4u:0u);
    if(rex || (bits==8u && !legacy))bytes[n++]=(pl_u8)(0x40u|rex);
    bytes[n++]=0x0fu;bytes[n++]=(pl_u8)((compare?0xb0u:0xc0u)+(bits!=8u));
    bytes[n++]=(pl_u8)(0xc0u|((src&7u)<<3u)|(dst&7u));return n;
}
static void model(machine_state *cpu,pl_u32 compare,pl_u32 bits,pl_u32 dst,pl_u32 src,pl_u32 legacy)
{
    pl_u64 d=read_lane(cpu,dst,bits,legacy),s=read_lane(cpu,src,bits,legacy);
    if(compare){
        if((cpu->registers[0]&mask(bits))==d)write_lane(cpu,dst,bits,legacy,s);
        else write_lane(cpu,0u,bits,0u,d);
    }else{
        write_lane(cpu,src,bits,legacy,d);write_lane(cpu,dst,bits,legacy,d+s);
    }
}
int main(int argc,char **argv)
{
    if(argc!=1 && argc!=2 && argc!=3)return 2;
    int observe_only=argc==3 && !strcmp(argv[2],"--observe");if(argc==3 && !observe_only)return 2;
    pl_u8 *code=mmap(0,4096,PROT_READ|PROT_WRITE|PROT_EXEC,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if(code==MAP_FAILED)return 1;
    static const pl_u32 pairs[][2]={{0,3},{1,2},{6,7},{8,15},{9,10},{11,12},{13,14},{0,0},{8,8},{5,2},
        {3,0},{0,1},{2,0},{2,2},{1,1}};
    static const pl_u32 high[][2]={{0,4},{4,0},{4,4},{4,7},{5,2},{6,3},{3,7}};
    pl_u64 seed=0x78616464636d7078ull;pl_u32 form=0u,observed=0u;int result=1;
    for(pl_u32 compare=0u;compare<2u;++compare)
    for(pl_u32 family=0u;family<2u;++family)
    for(pl_u32 width=0u;width<(family?1u:4u);++width)
    for(pl_u32 pair=0u;pair<(family?7u:15u);++pair)
    for(pl_u32 variant=0u;variant<3u;++variant,++form){
        pl_u32 bits=8u<<width,dst=family?high[pair][0]:pairs[pair][0],src=family?high[pair][1]:pairs[pair][1];
        memset(page,0x90,sizeof page);pl_u32 n=0u;
        if(variant==1u){page[n++]=0x49u;page[n++]=0x89u;page[n++]=0xcau;}
        n+=encode(page+n,compare,bits,dst,src,family);
        if(variant==2u)n+=encode(page+n,compare,bits,dst,src,family);
        if(variant==1u){page[n++]=0x4du;page[n++]=0x89u;page[n++]=0xd3u;}
        pl_u32 instructions=variant==1u?3u:variant==2u?2u:1u;
        memcpy(code,page,sizeof page);code[n]=0xc3u;
        for(pl_u32 row=0u;row<64u;++row){
            machine_state *before=&records[row][0],*actual=&records[row][1];memset(before,0,sizeof *before);
            for(pl_u32 reg=0u;reg<16u;++reg)before->registers[reg]=random_word(&seed);
            if(compare && (row&1u))write_lane(before,0u,bits,0u,read_lane(before,dst,bits,family));
            before->rflags=0x202u|(random_word(&seed)&0xcd5u);before->rip=0x400000u;before->retired=41u;
            *actual=*before;native_cut(actual,code);before->registers[4]=actual->registers[4];
            machine_state expected=*before;
            if(variant==1u)expected.registers[10]=expected.registers[1];
            model(&expected,compare,bits,dst,src,family);
            if(variant==2u)model(&expected,compare,bits,dst,src,family);
            if(variant==1u)expected.registers[11]=expected.registers[10];
            if(memcmp(expected.registers,actual->registers,sizeof expected.registers)){
                fprintf(stderr,"native update model: form=%u row=%u compare=%u bits=%u dst=%u src=%u\n",form,row,compare,bits,dst,src);
                for(pl_u32 reg=0u;reg<16u;++reg)if(expected.registers[reg]!=actual->registers[reg])
                    fprintf(stderr,"r%u expected=%llx actual=%llx\n",reg,expected.registers[reg],actual->registers[reg]);
                goto done;
            }
            actual->rip=before->rip+n;actual->retired+=instructions;++observed;
        }
        pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={image.entry,instructions,sizeof module};
        wasm_cut_report report;pl_u64 bytes=0u;
        if(!observe_only){
            int status=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report);
            if(status || report.source_bytes!=n || report.source_instructions!=instructions || report.memory_bytes){
                fprintf(stderr,"register update admission: form=%u status=%d\n",form,status);goto done;
            }
        }
        const char *directory=argc>=2?argv[1]:0;
        if(save(directory,form,"source-page",page,sizeof page) || save(directory,form,"cases",records,sizeof records)
                || (!observe_only && save(directory,form,"wasm",module,(size_t)bytes)))goto done;
    }
    result=0;printf("Register updates: %u forms / %u independent native GPR/defined flag observations%s\n",form,observed,
        observe_only?"; lowering not tested":"");
done:
    if(munmap(code,4096))result=1;
    return result;
}
