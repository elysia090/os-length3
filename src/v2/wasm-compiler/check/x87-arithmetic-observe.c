#include "x87-hardware.h"
#include <stdio.h>
#include <stdint.h>
/* Independent native observations, including states outside SoftFloat's
 * canonical domain. No product compiler or VM arithmetic is called here. */
#ifdef _WIN32
typedef struct {pl_u64 significand;pl_u16 se;pl_u8 empty;} operand;
static const operand values[]={
    {0u,0u,0u},{0u,0x8000u,0u},{0x8000000000000000ull,0x3fffu,0u},
    {0x8000000000000001ull,0x3fffu,0u},{0x8000000000000000ull,0xbfffu,0u},
    {0xc000000000000000ull,0x3fffu,0u},{1u,0u,0u},{0x7fffffffffffffffull,0u,0u},
    {0x8000000000000000ull,0u,0u},{0x8000000000000000ull,1u,0u},
    {0xffffffffffffffffull,0x7ffeu,0u},{0x8000000000000000ull,0x7fffu,0u},
    {0xc000000000000001ull,0x7fffu,0u},{0x8000000000000001ull,0x7fffu,0u},
    {1u,1u,0u},{0x8000000000000000ull,0x3fffu,1u}
};
static machine_state records[64][2];static pl_u64 integers[64];
static void put(void *at,pl_u64 x,pl_u32 n){for(pl_u32 i=0u;i<n;++i)((pl_u8 *)at)[i]=(pl_u8)(x>>(i*8u));}
static int save(const char *dir,pl_u32 form,const char *suffix,const void *bytes,size_t n)
{
    if(!dir)return 0;
    char path[4096];int length=snprintf(path,sizeof path,"%s/x87-arithmetic-%u.%s",dir,form,suffix);
    if(length<1||(size_t)length>=sizeof path)return 1;
    FILE *file=fopen(path,"wbx");if(!file)return 1;
    int bad=fwrite(bytes,1u,n,file)!=n;if(fclose(file))bad=1;return bad;
}
#endif
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    if(argc>2)return 2;
    const char *dir=argc==2?argv[1]:NULL;
    /* Code and operand occupy distinct pages. Only the current form's code
     * is made writable, then RX before observation; operand stays RW. */
    /* Windows' context format has 32-bit x87 ErrorOffset/DataOffset fields.
     * Keep both native oracle coordinates representable without truncation;
     * do not repair individual recorded pointers after an OS context switch. */
    pl_u8 *code=NULL;
    for(uintptr_t address=0x10000000u;!code&&address<0x70000000u;address+=65536u)
        code=VirtualAlloc((void *)address,8192u,MEM_COMMIT|MEM_RESERVE,PAGE_READWRITE);
    if(!code||(uintptr_t)code>0xffffffffu-8192u)return 1;
    const pl_u32 masks[]={0u,1u,2u,8u,16u,32u},groups[]={4u,0u,5u};
    pl_u32 rows=0u,changed=0u,pending=0u,published_pending=0u;int failed=1;
    for(pl_u32 form=0u;form<576u;++form){pl_u32 width=(form&1u)?2u:4u,operation=(form/2u)%3u;
        pl_u32 mode=form/6u,pc=mode&3u,rc=(mode>>2u)&3u,mask=masks[mode>>4u];DWORD previous;
        if(!VirtualProtect(code,4096u,PAGE_READWRITE,&previous))goto done;
        code[0]=(pl_u8)(width==4u?0xdau:0xdeu);code[1]=(pl_u8)((groups[operation]<<3u)|5u);
        put(code+2u,4090u,4u);code[6u]=0xc3u;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&previous)||!FlushInstructionCache(GetCurrentProcess(),code,7u))goto done;
        for(pl_u32 row=0u;row<64u;++row){const operand *value=values+(row&15u);pl_u32 top=row&7u;
            _Alignas(16) pl_u8 input[512]={0},before[512],after[512];
            put(input,(0x7fu|(pc<<8u)|(rc<<10u))&~mask,2u);put(input+2u,0x4700u|(top<<11u),2u);
            input[4u]=(pl_u8)(value->empty?255u&~(1u<<top):255u);put(input+6u,0x123u,2u);
            put(input+8u,0x12340000u,8u);put(input+16u,0x56780000u,8u);put(input+24u,0x1f80u,4u);
            for(pl_u32 k=0u;k<8u;++k){put(input+32u+k*16u,0x8000000000000000ull+k,8u);put(input+40u+k*16u,0x3fffu,2u);}
            put(input+32u,value->significand,8u);put(input+40u,value->se,2u);
            pl_u32 which=row>>4u;pl_u64 x=which==0u?0u:which==1u?1u:which==2u?~0ull:
                (row&1u)?(1ull<<(width*8u-1u))-1u:1ull<<(width*8u-1u);
            integers[row]=x;put(code+4096u,x,width);
            machine_state *a=&records[row][0],*b=a+1u;memset(a,0,sizeof *a);
            for(pl_u32 r=0u;r<16u;++r)a->registers[r]=0x123456789abc0000ull+r;
            a->rip=0x400000u;a->rflags=0xa92u|(row&1u)|((row&2u)<<1u);a->cr0=0x80010031u;a->cr3=0x1000u;a->cr4=32u;
            a->efer=0xd00u;a->retired=42u;a->system[MACHINE_SYSTEM_CS]=19u;a->system[MACHINE_SYSTEM_DR0+7u]=0x400u;*b=*a;
            check_x87_hardware(a,b,code,input,before,after);check_x87_project(a,before);check_x87_project(b,after);
            if(b->x87_ip==(pl_u64)(uintptr_t)code)b->x87_ip=a->rip;
            if(b->x87_dp==(pl_u64)(uintptr_t)(code+4096u))b->x87_dp=a->rip+4096u;
            b->rip+=6u;++b->retired;++rows;
            pl_u32 different=a->x87_significand[top]!=b->x87_significand[top]||a->x87_sign_exponent[top]!=b->x87_sign_exponent[top];
            changed+=different;if(b->x87_status&0x80u){++pending;published_pending+=different;}
        }
        char json[320];int n=snprintf(json,sizeof json,"{\"entry\":\"4194304\",\"sourceBytes\":6,\"stateBytes\":%zu,\"native\":64,\"bytes\":%u,\"operandOffset\":4096,\"pc\":%u,\"rc\":%u,\"operation\":%u,\"unmask\":%u,\"oracle\":\"physical Windows CPU\"}\n",sizeof(machine_state),width,pc,rc,operation,mask);
        if(n<1||(size_t)n>=sizeof json||save(dir,form,"json",json,(size_t)n)||save(dir,form,"cases",records,sizeof records)
            ||save(dir,form,"integers",integers,sizeof integers)||save(dir,form,"source",code,6u))goto done;
    }
    printf("{\"format\":\"native-x87-integer-arithmetic-v1\",\"status\":\"observed\",\"forms\":576,\"rows\":%u,\"payloadChanged\":%u,\"unmaskedPending\":%u,\"payloadChangedWhilePending\":%u,\"linuxBoot\":\"not-tested\"}\n",rows,changed,pending,published_pending);failed=0;
done:if(!VirtualFree(code,0u,MEM_RELEASE))failed=1;return failed;
#endif
}
