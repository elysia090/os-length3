#include "x87-hardware.h"
#include <stdio.h>
#include <stdint.h>
static machine_state records[64][2];static pl_u64 integers[64];
static void put(void *at,pl_u64 x,pl_u32 n){for(pl_u32 i=0u;i<n;++i)((pl_u8 *)at)[i]=(pl_u8)(x>>(i*8u));}
static int save(const char *dir,pl_u32 form,const char *suffix,const void *bytes,size_t n)
{
    if(!dir)return 0;
    char path[4096];int length=snprintf(path,sizeof path,"%s/x87-integer-%u.%s",dir,form,suffix);
    if(length<1||(size_t)length>=sizeof path)return 1;
    FILE *file=fopen(path,"wbx");if(!file)return 1;
    int bad=fwrite(bytes,1u,n,file)!=n;if(fclose(file))bad=1;return bad;
}
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    if(argc>2)return 2;
    const char *dir=argc==2?argv[1]:NULL;
    pl_u8 *code=VirtualAlloc(NULL,4096u,MEM_COMMIT|MEM_RESERVE,PAGE_EXECUTE_READWRITE);if(!code)return 1;
    pl_u64 seed=0x5284a973fea33411ull;pl_u32 rows=0u,published=0u;int failed=1;
    for(pl_u32 form=0u;form<192u;++form){pl_u32 width=(form%3u)==0u?2u:(form%3u)==1u?4u:8u;
        pl_u32 mode=form/3u,pc=mode&3u,rc=(mode>>2u)&3u,full=(mode>>4u)&1u,unmask=(mode>>5u)&1u;
        code[0]=(pl_u8)(width==4u?0xdbu:0xdfu);code[1]=(pl_u8)(width==8u?0x2du:0x05u);put(code+2u,250u,4u);code[6u]=0xc3u;
        for(pl_u32 row=0u;row<64u;++row){_Alignas(16) pl_u8 input[512]={0},before[512],after[512];pl_u32 top=row&7u,next=(top+7u)&7u;
            put(input,(0x7fu|(pc<<8u)|(rc<<10u))&~(unmask?1u:0u),2u);put(input+2u,0x4700u|(top<<11u),2u);
            input[4u]=(pl_u8)(full?255u:255u&~(1u<<next));put(input+6u,0x123u,2u);
            put(input+8u,0x12340000u,8u);put(input+16u,0x56780000u,8u);put(input+24u,0x1f80u,4u);
            for(pl_u32 k=0u;k<8u;++k){put(input+32u+k*16u,0x8000000000000000ull+k,8u);put(input+40u+k*16u,0x3fffu,2u);}
            seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;
            pl_u64 x=row==0u?0u:row==1u?1u:row==2u?~0ull:row==3u?(1ull<<(width*8u-1u)):row==4u?(1ull<<(width*8u-1u))-1u:seed;
            integers[row]=x;put(code+256u,x,width);
            machine_state *a=&records[row][0],*b=a+1u;memset(a,0,sizeof *a);
            for(pl_u32 r=0u;r<16u;++r)a->registers[r]=0x123456789abc0000ull+r;
            a->rip=0x400000u;a->rflags=0xa92u|(row&1u);a->cr0=0x80010031u;a->cr3=0x1000u;a->cr4=32u;a->efer=0xd00u;a->retired=42u;
            a->system[MACHINE_SYSTEM_CS]=19u;a->system[MACHINE_SYSTEM_DR0+7u]=0x400u;*b=*a;
            check_x87_hardware(a,b,code,input,before,after);check_x87_project(a,before);check_x87_project(b,after);
            if(b->x87_ip==(pl_u64)(uintptr_t)code)b->x87_ip=a->rip;
            if(b->x87_dp==(pl_u64)(uintptr_t)(code+256u))b->x87_dp=a->rip+256u;
            b->rip+=6u;++b->retired;++rows;published+=((b->x87_status>>11u)&7u)!=top;
        }
        char json[256];int n=snprintf(json,sizeof json,"{\"entry\":\"4194304\",\"sourceBytes\":6,\"stateBytes\":%zu,\"native\":64,\"bytes\":%u,\"pc\":%u,\"rc\":%u,\"full\":%u,\"unmask\":%u,\"oracle\":\"physical Windows CPU\"}\n",sizeof(machine_state),width,pc,rc,full,unmask);
        if(n<1||(size_t)n>=sizeof json||save(dir,form,"json",json,(size_t)n)||save(dir,form,"cases",records,sizeof records)
            ||save(dir,form,"integers",integers,sizeof integers)||save(dir,form,"source",code,6u))goto done;
    }
    printf("{\"format\":\"native-x87-integer-load-v1\",\"forms\":192,\"rows\":%u,\"topChanged\":%u,\"oracle\":\"physical Windows FPU/RFLAGS; GPR invariance architectural\"}\n",rows,published);failed=0;
done:if(!VirtualFree(code,0u,MEM_RELEASE))failed=1;return failed;
#endif
}
