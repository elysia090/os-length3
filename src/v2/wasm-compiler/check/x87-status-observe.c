#include "x87-hardware.h"
#include <stdio.h>
#include <stdint.h>
/* Hardware oracle only; numeric and status results are not computed in C. */
#ifdef _WIN32
typedef struct {pl_u64 sig;pl_u16 se;pl_u8 empty;} value;
static const value extended[]={
    {0u,0u,0u},{0u,0x8000u,0u},{0x8000000000000000ull,0x3fffu,0u},
    {0x8000000000000001ull,0x3fffu,0u},{0x8000000000000000ull,0xbfffu,0u},
    {0xc000000000000000ull,0x3fffu,0u},{1u,0u,0u},{0x7fffffffffffffffull,0u,0u},
    {0x8000000000000000ull,0u,0u},{0x8000000000000000ull,1u,0u},
    {0x8000000000000000ull,0x7fffu,0u},{0x8000000000000000ull,0xffffu,0u},
    {0xc000000000000001ull,0x7fffu,0u},{0x8000000000000001ull,0x7fffu,0u},
    {1u,1u,0u},{0x8000000000000000ull,0x3fffu,1u}
};
static const pl_u64 binary32[]={0u,0x80000000u,0x3f800000u,0x3f800001u,0xbf800000u,0x3fc00000u,1u,0x7fffffu,
    0x800000u,0x7f7fffffu,0x7f800000u,0xff800000u,0x7fc00001u,0x7f800001u,0x40000000u,0x7b000000u};
static const pl_u64 binary64[]={0u,0x8000000000000000ull,0x3ff0000000000000ull,0x3ff0000000000001ull,0xbff0000000000000ull,
    0x3ff8000000000000ull,1u,0xfffffffffffffull,0x10000000000000ull,0x7fefffffffffffffull,0x7ff0000000000000ull,
    0xfff0000000000000ull,0x7ff8000000000001ull,0x7ff0000000000001ull,0x4000000000000000ull,0x7b00000000000000ull};
static const pl_u64 signed_words[]={0u,1u,~0ull,0x8000u,0x7fffu,2u,7u,~6ull,0x80000000u,0x7fffffffu,
    0xffff8000u,0x10000u,0xffffffffu,0x12345678u,0x87654321u,0xaaaau};
static machine_state records[256][2];static pl_u64 operands[256];
static const char *record_prefix="x87-status";
static void put(void *at,pl_u64 x,pl_u32 n){for(pl_u32 i=0u;i<n;++i)((pl_u8 *)at)[i]=(pl_u8)(x>>(i*8u));}
static int save(const char *dir,pl_u32 form,const char *suffix,const void *bytes,size_t n)
{
    if(!dir)return 0;
    char path[4096];int length=snprintf(path,sizeof path,"%s/%s-%u.%s",dir,record_prefix,form,suffix);
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
    int aliases=argc==3&&!strcmp(argv[2],"--aliases");if(argc>2&&!aliases)return 2;
    const char *dir=argc>=2?argv[1]:NULL;pl_u8 *code=NULL;if(aliases)record_prefix="x87-status-alias";
    /* Representable native pointers avoid host x87 context truncation. */
    for(uintptr_t address=0x10000000u;!code&&address<0x70000000u;address+=65536u)
        code=VirtualAlloc((void *)address,8192u,MEM_COMMIT|MEM_RESERVE,PAGE_READWRITE);
    if(!code)return 1;
    pl_u32 rows=0u,pending=0u,popped_pending=0u,c1_kept=0u,cc_changed_pending=0u;int failed=1;
    for(pl_u32 form=0u;form<(aliases?96u:172u);++form){pl_u32 family=aliases?43u+(form%24u):form<168u?form%42u:42u,
        mask=aliases?form/24u:form<168u?form/42u:form-168u,memory=family<8u,width=0u,pop,ordered,source=0u;
        DWORD previous;if(!VirtualProtect(code,4096u,PAGE_READWRITE,&previous))goto done;
        if(memory){pl_u32 integer=family>=4u;pop=!(family&1u);ordered=1u;
            width=integer?(family<6u?2u:4u):(family<2u?4u:8u);
            code[0]=(pl_u8)(integer?(width==2u?0xdeu:0xdau):(width==4u?0xd8u:0xdcu));
            code[1]=(pl_u8)(((pop?3u:2u)<<3u)|5u);put(code+2u,4090u,4u);code[6u]=0xc3u;
        }else if(family<40u){pl_u32 mode=(family-8u)/8u;source=(family-8u)&7u;pop=!(mode&1u);ordered=mode<2u;
            code[0]=(pl_u8)(ordered?0xd8u:0xddu);code[1]=(pl_u8)((ordered?0xd0u:0xe0u)|(pop?8u:0u)|source);code[2u]=0xc3u;
        }else if(family<42u){source=1u;pop=2u;ordered=family==40u;code[0]=(pl_u8)(ordered?0xdeu:0xdau);code[1]=(pl_u8)(ordered?0xd9u:0xe9u);code[2u]=0xc3u;}
        else if(family==42u){pop=0u;ordered=1u;code[0]=0xd9u;code[1]=0xe4u;code[2u]=0xc3u;}
        else{pl_u32 alias=family-43u;source=alias&7u;pop=alias>=8u;ordered=1u;code[0]=(pl_u8)(alias<16u?0xdcu:0xdeu);
            code[1]=(pl_u8)(0xd0u+source+(alias>=8u&&alias<16u?8u:0u));code[2u]=0xc3u;}
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&previous)||!FlushInstructionCache(GetCurrentProcess(),code,7u))goto done;
        for(pl_u32 row=0u;row<256u;++row){pl_u32 left=row/16u,right=row&15u,top=(left+right)&7u;
            const value *a=extended+left,*b=extended+(source?right:left);
            _Alignas(16) pl_u8 input[512]={0},before[512],after[512];
            pl_u32 old_cc=((left&1u)?0x100u:0u)|((right&1u)?0x400u:0u)|(((left^right)&2u)?0x4000u:0u);
            put(input,0x37fu&~mask,2u);put(input+2u,old_cc|0x200u|(top<<11u),2u);input[4u]=255u;
            put(input+6u,0x123u,2u);put(input+8u,0x12340000u,8u);put(input+16u,0x56780000u,8u);put(input+24u,0x1f80u,4u);
            for(pl_u32 k=0u;k<8u;++k){put(input+32u+k*16u,0x8000000000000000ull+k,8u);put(input+40u+k*16u,0x3fffu,2u);}
            put(input+32u,a->sig,8u);put(input+40u,a->se,2u);
            if(a->empty)input[4u]=(pl_u8)(input[4u]&~(1u<<top));
            if(!memory){put(input+32u+source*16u,b->sig,8u);put(input+40u+source*16u,b->se,2u);
                if(b->empty)input[4u]=(pl_u8)(input[4u]&~(1u<<((top+source)&7u)));}
            pl_u64 operand=memory?(family>=4u?signed_words[right]:width==4u?binary32[right]:binary64[right]):0u;
            operands[row]=operand;if(memory)put(code+4096u,operand,width);
            machine_state *first=&records[row][0],*last=first+1u;memset(first,0,sizeof *first);
            for(pl_u32 r=0u;r<16u;++r)first->registers[r]=0x123456789abc0000ull+r;
            first->rip=0x400000u;first->rflags=0xa92u|((left&1u)?1u:0u)|((right&1u)?4u:0u)|(((left^right)&2u)?0x40u:0u);
            first->cr0=0x80010031u;first->cr3=0x1000u;first->cr4=32u;first->efer=0xd00u;first->retired=42u;
            first->system[MACHINE_SYSTEM_CS]=19u;first->system[MACHINE_SYSTEM_DR0+7u]=0x400u;*last=*first;
            check_x87_hardware(first,last,code,input,before,after);check_x87_project(first,before);check_x87_project(last,after);
            if(last->x87_ip==(pl_u64)(uintptr_t)code)last->x87_ip=first->rip;
            if(last->x87_dp==(pl_u64)(uintptr_t)(code+4096u))last->x87_dp=first->rip+4096u;
            last->rip+=memory?6u:2u;++last->retired;++rows;c1_kept+=(last->x87_status&0x200u)!=0u;
            if(last->x87_status&0x80u){++pending;popped_pending+=(last->x87_status&0x3800u)!=(first->x87_status&0x3800u);
                cc_changed_pending+=(last->x87_status&0x4500u)!=(first->x87_status&0x4500u);}
        }
        char json[320];int n=snprintf(json,sizeof json,"{\"entry\":\"4194304\",\"sourceBytes\":%u,\"stateBytes\":%zu,\"native\":256,\"bytes\":%u,\"operandOffset\":4096,\"pop\":%u,\"ordered\":%u,\"sourceIndex\":%u,\"family\":%u,\"unmask\":%u,\"oracle\":\"physical Windows CPU\"}\n",memory?6u:2u,sizeof(machine_state),width,pop,ordered,source,family,mask);
        if(n<1||(size_t)n>=sizeof json||save(dir,form,"json",json,(size_t)n)||save(dir,form,"cases",records,sizeof records)
            ||save(dir,form,"operands",operands,sizeof operands)||save(dir,form,"source",code,memory?6u:2u))goto done;
    }
    printf("{\"format\":\"native-x87-status-compare-v1\",\"status\":\"observed\",\"forms\":%u,\"rows\":%u,\"unmaskedPending\":%u,\"poppedWhilePending\":%u,\"c1Retained\":%u,\"ccChangedWhilePending\":%u,\"linuxBoot\":\"not-tested\"}\n",aliases?96u:172u,rows,pending,popped_pending,c1_kept,cc_changed_pending);failed=0;
done:if(!VirtualFree(code,0u,MEM_RELEASE))failed=1;return failed;
#endif
}
