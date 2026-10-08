#include <wasm-compiler/cut.h>
#include <stdio.h>
#include <string.h>

static const pl_u8 forms[][8]={
    {0x90},{0x48,0x89,0xd8},{0x48,0x8b,0x07},{0x48,0x01,0x07},
    {0x48,0x0f,0xae,0x07},{0x48,0x0f,0xae,0x0f},{0x8e,0xe0},{0x0f,0x00,0x17},
    {0x48,0x0f,0xc7,0x0f},{0x0f,0x01,0x17},{0xf3,0x0f,0x6f,0x07},{0xf3,0x0f,0x7f,0x07},
    {0x48,0xcb},{0x0f,0x22,0xd8},{0x48,0xcf},{0x0f,0x32},{0x0f,0x21,0xc0},
    {0xec},{0x0f,0x31},{0xfb},{0xcc},{0x0f,0x05},{0xc3},{0xe8,0,0,0,0},
    {0x48,0x8b,0x05,1,2,3,4},{0x66,0x0f,0x76,0xc0},{0xf4},{0x75,0}
};
static const pl_u32 lengths[]={1,3,3,3,4,4,2,3,4,3,4,4,2,3,2,2,3,1,2,1,1,2,1,5,7,4,1,2};
enum { COUNT=sizeof lengths/sizeof lengths[0] };
static pl_u8 page[4096],single[65536],module[65536],saved[65536];
static wasm_cut_options options[WASM_CUT_MODULE_MAX_FUNCTIONS];
static wasm_cut_report reports[WASM_CUT_MODULE_MAX_FUNCTIONS],before[WASM_CUT_MODULE_MAX_FUNCTIONS];
static int save(const char *directory,const char *name,const void *bytes,size_t count)
{
    char path[4096];int n=snprintf(path,sizeof path,"%s/%s",directory,name);
    if(n<1 || (size_t)n>=sizeof path)return -1;
    FILE *file=fopen(path,"wbx");if(!file)return -1;
    int status=fwrite(bytes,1u,count,file)==count?0:-1;
    if(fclose(file))status=-1;
    return status;
}
int main(int argc,char **argv)
{
    if(argc!=1 && argc!=2)return 2;
    memset(page,0x90,sizeof page);
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
    pl_x86_image source={&map,1u,0u,map.address};
    pl_u64 bytes=0u,singles=0u;
    for(pl_u32 i=0u;i<COUNT;++i){
        memcpy(page+i*64u,forms[i],lengths[i]);
        options[i]=(wasm_cut_options){map.address+i*64u,1u,sizeof module};
    }
    for(pl_u32 i=0u;i<COUNT;++i){
        wasm_cut_report report;
        int status=wasm_compiler_emit_code_cut(&source,9u,options+i,single,sizeof single,&bytes,&report);
        if(status){fprintf(stderr,"cut module: single form %u status %d\n",i,status);return 3;}
        singles+=bytes;
        if(argc==2){char name[64];snprintf(name,sizeof name,"cut-%u.wasm",i);
            if(save(argv[1],name,single,(size_t)bytes))return 4;}
    }
    if(wasm_compiler_emit_code_module(&source,9u,options,COUNT,module,sizeof module,&bytes,reports))return 5;
    pl_u64 combined=bytes;
    if(combined>=singles)return 6;
    for(pl_u32 i=0u;i<COUNT;++i)
        if(reports[i].entry!=options[i].entry || reports[i].source_bytes!=lengths[i]
                || reports[i].source_instructions!=1u || reports[i].module_bytes!=combined)return 7;
    if(argc==2 && (save(argv[1],"combined.wasm",module,(size_t)combined)
            || save(argv[1],"reports",reports,COUNT*sizeof *reports)
            || save(argv[1],"source-page",page,sizeof page)))return 8;
    /* One-function collection is byte-identical to the ordinary cut path. */
    if(wasm_compiler_emit_code_cut(&source,9u,options,single,sizeof single,&bytes,0))return 9;
    pl_u64 one=0u;
    if(wasm_compiler_emit_code_module(&source,9u,options,1u,module,sizeof module,&one,0)
            || one!=bytes || memcmp(module,single,(size_t)one))return 10;
    /* All publication failures leave the caller's bytes/report/written intact. */
    for(pl_u32 case_id=0u;case_id<7u;++case_id){
        memset(module,0xa5,sizeof module);memcpy(saved,module,sizeof module);
        memset(reports,0xa5,sizeof reports);memcpy(before,reports,sizeof reports);bytes=77u;
        pl_u64 old=options[1].entry;pl_u32 old_cap=options[1].maximum_module_bytes;
        pl_u8 old_byte=page[(COUNT-1u)*64u];
        pl_u8 old_second=page[(COUNT-1u)*64u+1u];
        pl_u32 count=COUNT;pl_u64 capacity=sizeof module;
        if(case_id==0u)count=0u;
        if(case_id==1u)count=WASM_CUT_MODULE_MAX_FUNCTIONS+1u;
        if(case_id==2u)options[1].entry=options[0].entry;
        if(case_id==3u)capacity=1u;
        if(case_id==4u)options[1].maximum_module_bytes=1u;
        if(case_id==5u){page[(COUNT-1u)*64u]=0xcdu;page[(COUNT-1u)*64u+1u]=1u;}
        int status=wasm_compiler_emit_code_module(&source,9u,options,count,module,capacity,
            case_id==6u?(pl_u64 *)reports:&bytes,reports);
        options[1].entry=old;options[1].maximum_module_bytes=old_cap;page[(COUNT-1u)*64u]=old_byte;
        page[(COUNT-1u)*64u+1u]=old_second;
        if(!status || bytes!=77u || memcmp(module,saved,sizeof module) || memcmp(reports,before,sizeof reports))return 11;
    }
    /* ULEB count/index boundary, still one interface and bounded workspace. */
    memset(page,0x90,sizeof page);
    for(pl_u32 i=0u;i<129u;++i)options[i]=(wasm_cut_options){map.address+i,1u,sizeof module};
    if(wasm_compiler_emit_code_module(&source,9u,options,129u,module,sizeof module,&bytes,reports))return 12;
    if(argc==2 && save(argv[1],"count-129.wasm",module,(size_t)bytes))return 13;
    printf("Cut module: 28 mixed cuts %llu -> %llu bytes, one-function byte parity, 7 unchanged failures, 129-function boundary; NOT ELF closure\n",singles,combined);
    return 0;
}
