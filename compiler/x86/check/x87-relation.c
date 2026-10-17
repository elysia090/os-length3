#include "scalar-plan.h"
#include <stdio.h>
#include <string.h>
static pl_u64 read64(const pl_u8 *p){pl_u64 v=0u;for(pl_u32 i=0u;i<8u;++i)v|=(pl_u64)p[i]<<(i*8u);return v;}
static pl_u32 read16(const pl_u8 *p){return (pl_u32)p[0]|((pl_u32)p[1]<<8u);}
int main(int argc,char **argv)
{
    if(argc!=2)return 2;
    pl_u32 compared=0u,max_work=0u,max_span=0u;pl_u8 before[1256],after[1256];
    for(pl_u32 form=0u;form<64u;++form){_Alignas(8) pl_u8 scratch[32768];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;
        pl_u32 target=form&7u,ordered=(form>>4u)&1u;
        int status=pl_x86_x87_relation_plan(ordered,!target,&arena,&plan);
        if(status){fprintf(stderr,"relation plan=%d form=%u used=%u\n",status,form,arena.used);return 1;}
        if(plan.node_count>max_work)max_work=plan.node_count;
        if(plan.span>max_span)max_span=plan.span;
        char path[4096];int n=snprintf(path,sizeof path,"%s/x87-compare-%u.cases",argv[1],form);
        if(n<1||(size_t)n>=sizeof path)return 2;
        FILE *file=fopen(path,"rb");if(!file)return 2;
        for(pl_u32 row=0u;row<256u;++row){if(fread(before,1u,sizeof before,file)!=sizeof before||fread(after,1u,sizeof after,file)!=sizeof after){fclose(file);return 2;}
            pl_u32 top=(read16(before+1234u)>>11u)&7u,other=(top+target)&7u,tag=read16(before+1236u);
            pl_u64 input[]={read64(before+1152u+top*8u),read16(before+1216u+top*2u),read64(before+1152u+other*8u),read16(before+1216u+other*2u),
                ((tag>>(top*2u))&3u)==3u||((tag>>(other*2u))&3u)==3u};
            pl_u64 output[3];if(check_scalar_plan(&plan,input,output)){fclose(file);return 1;}
            pl_u64 relation=read64(after+392u)&69u,raised=read16(after+1234u)&0x43u;
            if(output[0]!=relation||output[1]!=raised){fprintf(stderr,"relation mismatch form=%u row=%u flags=%llu/%llu raised=%llu/%llu\n",form,row,
                (unsigned long long)output[0],(unsigned long long)relation,(unsigned long long)output[1],(unsigned long long)raised);fclose(file);return 1;}
            ++compared;
        }
        if(fgetc(file)!=EOF||fclose(file))return 2;
    }
    printf("Extended relation: %u actual native rows / four shared SSA plans, max work=%u span=%u; no state/event implementation claim\n",compared,max_work,max_span);return 0;
}
