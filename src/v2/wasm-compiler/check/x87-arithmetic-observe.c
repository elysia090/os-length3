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
/* Same hardware capture, but TWO raw extended operands. The larger matrix
 * is one bounded form buffer, not a materialized population in memory. */
static int observe_register(const char *dir,pl_u8 *code)
{
    static const operand extra[]={
        {0x8000000000000000ull,0xffffu,0u},
        {0xc000000000000002ull,0xffffu,0u},
        {0x8000000000000002ull,0xffffu,0u},{1u,0x8000u,0u}
    };
    static const pl_u8 edges[][2]={{2,3},{3,2},{6,7},{7,6},{8,9},{9,8},{10,10},{9,6},
        {12,13},{13,12},{14,2},{2,14},{15,2},{2,15},{0,1},{16,11}};
    static machine_state rows[1536][2];
    const pl_u32 masks[]={0u,1u,2u,8u,16u,32u};
    pl_u32 observed=0u,pending=0u,changed_pending=0u,popped_pending=0u;
    for(pl_u32 form=0u;form<81u;++form){
        /* The real make gap DC ED is first. All 72 encodings still occur
         * exactly once in the complete masked operand-pair population. */
        pl_u32 rank=form==0u?37u:form==37u?0u:form;
        pl_u32 family=form<72u?rank/8u:form-72u,index=form<72u?rank&7u:5u;
        pl_u32 encoding=family/3u,op=family%3u,destination=encoding?index:0u,source=encoding?0u:index;
        pl_u32 pop=encoding==2u,native=form<72u?400u:1536u;
        DWORD old;if(!VirtualProtect(code,4096u,PAGE_READWRITE,&old))return 1;
        code[0]=(pl_u8)(encoding==0u?0xd8u:encoding==1u?0xdcu:0xdeu);
        code[1]=(pl_u8)((op==0u?0xc0u:op==1u?(encoding?0xe8u:0xe0u):(encoding?0xe0u:0xe8u))|index);
        code[2]=0xc3u;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&old)||!FlushInstructionCache(GetCurrentProcess(),code,3u))return 1;
        for(pl_u32 row=0u;row<native;++row){
            pl_u32 mode=form<72u?0u:row/16u,left=form<72u?row/20u:edges[row&15u][0];
            pl_u32 right=form<72u?row%20u:edges[row&15u][1],pc=form<72u?3u:mode&3u;
            pl_u32 rc=form<72u?0u:(mode>>2u)&3u,mask=form<72u?0u:masks[mode>>4u],top=(left+right+row/20u)&7u;
            const operand *a=left<16u?values+left:extra+left-16u;
            const operand *b=index?(right<16u?values+right:extra+right-16u):a;
            _Alignas(16) pl_u8 input[512]={0},before[512],after[512];
            put(input,(0x7fu|(pc<<8u)|(rc<<10u))&~mask,2u);put(input+2u,0x4700u|(top<<11u),2u);
            input[4]=255u;put(input+6u,0x123u,2u);put(input+8u,0x12340000u,8u);
            put(input+16u,0x56780000u,8u);put(input+24u,0x1f80u,4u);
            for(pl_u32 k=0u;k<8u;++k){put(input+32u+k*16u,0x8000000000000000ull+k,8u);put(input+40u+k*16u,0x3fffu,2u);}
            put(input+32u,a->significand,8u);put(input+40u,a->se,2u);
            put(input+32u+index*16u,b->significand,8u);put(input+40u+index*16u,b->se,2u);
            if(a->empty)input[4]=(pl_u8)(input[4]&~(1u<<top));
            if(b->empty)input[4]=(pl_u8)(input[4]&~(1u<<((top+index)&7u)));
            machine_state *first=rows[row],*last=first+1u;memset(first,0,sizeof *first);
            for(pl_u32 r=0u;r<16u;++r)first->registers[r]=0x123456789abc0000ull+r;
            first->rip=0x400000u;first->rflags=0xa92u|(row&1u)|((row&2u)<<1u);
            first->cr0=0x80010031u;first->cr3=0x1000u;first->cr4=32u;first->efer=0xd00u;
            first->retired=42u;first->system[MACHINE_SYSTEM_CS]=19u;first->system[MACHINE_SYSTEM_DR0+7u]=0x400u;*last=*first;
            check_x87_hardware(first,last,code,input,before,after);check_x87_project(first,before);check_x87_project(last,after);
            if(last->x87_ip==(pl_u64)(uintptr_t)code)last->x87_ip=first->rip;
            last->rip+=2u;++last->retired;++observed;
            pl_u32 physical=(top+destination)&7u,different=first->x87_significand[physical]!=last->x87_significand[physical]
                ||first->x87_sign_exponent[physical]!=last->x87_sign_exponent[physical];
            if(last->x87_status&0x80u){++pending;changed_pending+=different;
                popped_pending+=pop&&((first->x87_status&0x3800u)!=(last->x87_status&0x3800u));}
        }
        char name[4096],json[384];int n=snprintf(json,sizeof json,
            "{\"entry\":\"4194304\",\"sourceBytes\":2,\"stateBytes\":%zu,\"native\":%u,\"bytes\":0,\"sourceIndex\":%u,\"destinationIndex\":%u,\"operation\":%u,\"pop\":%u,\"controlMatrix\":%s,\"oracle\":\"physical Windows CPU\"}\n",
            sizeof(machine_state),native,source,destination,op==0u?0u:op==1u?2u:3u,pop,form<72u?"false":"true");
        if(n<1||(size_t)n>=sizeof json)return 1;
        if(dir){const char *suffix[]={"json","source","cases"};const void *data[]={json,code,rows};
            const size_t count[]={(size_t)n,2u,(size_t)native*sizeof rows[0]};
            for(pl_u32 file=0u;file<3u;++file){int length=snprintf(name,sizeof name,"%s/x87-register-%u.%s",dir,form,suffix[file]);
                if(length<1||(size_t)length>=sizeof name)return 1;
                FILE *out=fopen(name,"wbx");if(!out)return 1;int bad=fwrite(data[file],1u,count[file],out)!=count[file];
                if(fclose(out))bad=1;
                if(bad)return 1;}}
    }
    printf("{\"format\":\"native-x87-register-arithmetic-v1\",\"status\":\"observed\",\"forms\":81,\"sourceEncodings\":72,\"rows\":%u,\"unmaskedPending\":%u,\"payloadChangedWhilePending\":%u,\"poppedWhilePending\":%u,\"linuxBoot\":\"not-tested\"}\n",
        observed,pending,changed_pending,popped_pending);return 0;
}
#endif
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    int register_mode=argc==3&&!strcmp(argv[2],"--register");
    if(argc>3||(argc==3&&!register_mode))return 2;
    const char *dir=argc>=2?argv[1]:NULL;
    /* Code and operand occupy distinct pages. Only the current form's code
     * is made writable, then RX before observation; operand stays RW. */
    /* Windows' context format has 32-bit x87 ErrorOffset/DataOffset fields.
     * Keep both native oracle coordinates representable without truncation;
     * do not repair individual recorded pointers after an OS context switch. */
    pl_u8 *code=NULL;
    for(uintptr_t address=0x10000000u;!code&&address<0x70000000u;address+=65536u)
        code=VirtualAlloc((void *)address,8192u,MEM_COMMIT|MEM_RESERVE,PAGE_READWRITE);
    if(!code||(uintptr_t)code>0xffffffffu-8192u)return 1;
    if(register_mode){int result=observe_register(dir,code);if(!VirtualFree(code,0u,MEM_RELEASE))result=1;return result;}
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
