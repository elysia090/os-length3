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
static machine_state records[128][2];static pl_u64 integers[128];
static const char *record_prefix="x87-arithmetic";
static void put(void *at,pl_u64 x,pl_u32 n){for(pl_u32 i=0u;i<n;++i)((pl_u8 *)at)[i]=(pl_u8)(x>>(i*8u));}
static int save(const char *dir,pl_u32 form,const char *suffix,const void *bytes,size_t n)
{
    if(!dir)return 0;
    char path[4096];int length=snprintf(path,sizeof path,"%s/%s-%u.%s",dir,record_prefix,form,suffix);
    if(length<1||(size_t)length>=sizeof path)return 1;
    FILE *file=fopen(path,"wbx");if(!file)return 1;
    int bad=fwrite(bytes,1u,n,file)!=n;if(fclose(file))bad=1;return bad;
}
/* Same hardware capture, but TWO raw extended operands. The larger matrix
 * is one bounded form buffer, not a materialized population in memory. */
static int observe_register(const char *dir,pl_u8 *code,int divide)
{
    int multiply=divide==2;divide=divide==1;
    static const operand extra[]={
        {0x8000000000000000ull,0xffffu,0u},
        {0xc000000000000002ull,0xffffu,0u},
        {0x8000000000000002ull,0xffffu,0u},{1u,0x8000u,0u}
    };
    static const pl_u8 edges[][2]={{2,3},{3,2},{6,7},{7,6},{8,9},{9,8},{10,10},{9,6},
        {12,13},{13,12},{14,2},{2,14},{15,2},{2,15},{0,1},{16,11},{2,0},{0,2},{2,1},{1,2}};
    static machine_state rows[2240][2];
    const pl_u32 masks[]={0u,1u,2u,8u,16u,32u};
    const pl_u32 division_masks[]={0u,1u,2u,4u,8u,16u,32u};
    pl_u32 observed=0u,pending=0u,changed_pending=0u,popped_pending=0u;
    pl_u32 base=multiply?24u:divide?48u:72u,families=multiply?3u:divide?6u:9u;
    for(pl_u32 form=0u;form<base+families;++form){
        /* The real make gap DC ED is first. All 72 encodings still occur
         * exactly once in the complete masked operand-pair population. */
        pl_u32 rank=(divide||multiply)?form:form==0u?37u:form==37u?0u:form;
        pl_u32 family=form<base?rank/8u:form-base,index=form<base?rank&7u:5u;
        pl_u32 encoding=family/(multiply?1u:divide?2u:3u),op=family%(multiply?1u:divide?2u:3u),destination=encoding?index:0u,source=encoding?0u:index;
        pl_u32 pop=encoding==2u,pairs=divide?20u:16u,native=form<base?400u:divide?2240u:1536u;
        DWORD old;if(!VirtualProtect(code,4096u,PAGE_READWRITE,&old))return 1;
        code[0]=(pl_u8)(encoding==0u?0xd8u:encoding==1u?0xdcu:0xdeu);
        code[1]=(pl_u8)((multiply?0xc8u:divide?(op?(encoding?0xf0u:0xf8u):(encoding?0xf8u:0xf0u)):
            op==0u?0xc0u:op==1u?(encoding?0xe8u:0xe0u):(encoding?0xe0u:0xe8u))|index);
        code[2]=0xc3u;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&old)||!FlushInstructionCache(GetCurrentProcess(),code,3u))return 1;
        for(pl_u32 row=0u;row<native;++row){
            pl_u32 mode=form<base?0u:row/pairs,left=form<base?row/20u:edges[row%pairs][0];
            pl_u32 right=form<base?row%20u:edges[row%pairs][1],pc=form<base?3u:mode&3u;
            pl_u32 rc=form<base?0u:(mode>>2u)&3u,mask=form<base?0u:divide?division_masks[mode>>4u]:masks[mode>>4u],top=(left+right+row/20u)&7u;
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
            sizeof(machine_state),native,source,destination,multiply?1u:divide?op+4u:op==0u?0u:op==1u?2u:3u,pop,form<base?"false":"true");
        if(n<1||(size_t)n>=sizeof json)return 1;
        if(dir){const char *suffix[]={"json","source","cases"};const void *data[]={json,code,rows};
            const size_t count[]={(size_t)n,2u,(size_t)native*sizeof rows[0]};
            for(pl_u32 file=0u;file<3u;++file){int length=snprintf(name,sizeof name,"%s/x87-%s-%u.%s",dir,multiply?"register-multiply":divide?"register-divide":"register",form,suffix[file]);
                if(length<1||(size_t)length>=sizeof name)return 1;
                FILE *out=fopen(name,"wbx");if(!out)return 1;int bad=fwrite(data[file],1u,count[file],out)!=count[file];
                if(fclose(out))bad=1;
                if(bad)return 1;}}
    }
    printf("{\"format\":\"native-x87-register-%s-v1\",\"status\":\"observed\",\"forms\":%u,\"sourceEncodings\":%u,\"rows\":%u,\"unmaskedPending\":%u,\"payloadChangedWhilePending\":%u,\"poppedWhilePending\":%u,\"linuxBoot\":\"not-tested\"}\n",
        multiply?"multiply":divide?"divide":"arithmetic",base+families,base,observed,pending,changed_pending,popped_pending);return 0;
}
static int observe_store(const char *dir,pl_u8 *code,int load)
{
    const operand extra[]={
        {0xa000000000000000ull,0x4000u,0u},{0xa000000000000000ull,0xc000u,0u},
        {0xffff000000000000ull,0x400du,0u},{0x8000000000000000ull,0x400eu,0u},
        {0x8000000000000000ull,0xc00eu,0u},{0x8000800000000000ull,0xc00eu,0u},
        {0xffffffff00000000ull,0x401du,0u},{0x8000000000000000ull,0x401eu,0u},
        {0x8000000000000000ull,0xc01eu,0u},{0xfffffffffffffffeull,0x403du,0u},
        {0x8000000000000000ull,0x403eu,0u},{0x8000000000000000ull,0xc03eu,0u},
        {0x8000000000000001ull,0xc03eu,0u},{0x8000000000000000ull,0x3ffeu,0u},
        {0x8000000000000000ull,0xbffeu,0u},{0x8000000000000001ull,0x3ffeu,0u}
    };
    const pl_u8 primary[]={0xdfu,0xdbu,0xdfu,0xdbu,0xdfu,0xdfu,0xdbu,0xddu};
    const pl_u8 group[]={2u,2u,3u,3u,7u,1u,1u,1u},width[]={2u,4u,2u,4u,8u,2u,4u,8u};
    const pl_u32 masks[]={0u,1u,32u},load_masks[]={0u,1u,2u};pl_u64 written[64];pl_u32 observed=0u,pending=0u,kept=0u;
    record_prefix=load?"x87-ieee-load":"x87-integer-store";pl_u32 formats=load?2u:8u,forms=load?96u:384u;
    for(pl_u32 form=0u;form<forms;++form){pl_u32 encoding=form%formats,mode=form/formats,pc=mode&3u,rc=(mode>>2u)&3u;
        pl_u32 mask=load?load_masks[mode>>4u]:masks[mode>>4u],bytes=load?(encoding?8u:4u):width[encoding];DWORD old;
        if(!VirtualProtect(code,4096u,PAGE_READWRITE,&old))return 1;
        code[0]=load?(pl_u8)(encoding?0xddu:0xd9u):primary[encoding];code[1]=load?5u:(pl_u8)((group[encoding]<<3u)|5u);put(code+2u,4090u,4u);code[6]=0xc3u;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&old)||!FlushInstructionCache(GetCurrentProcess(),code,7u))return 1;
        for(pl_u32 row=0u;row<64u;++row){pl_u32 value=row%32u,top=(row+form)&7u;const operand *a=value<16u?values+value:extra+value-16u;
            _Alignas(16) pl_u8 input[512]={0},before[512],after[512];
            put(input,(0x7fu|(pc<<8u)|(rc<<10u))&~mask,2u);put(input+2u,0x4700u|(top<<11u),2u);
            input[4]=load?(pl_u8)((row&16u)?255u:255u&~(1u<<((top+7u)&7u))):(pl_u8)(a->empty?255u&~(1u<<top):255u);put(input+6u,0x123u,2u);
            put(input+8u,0x12340000u,8u);put(input+16u,0x56780000u,8u);put(input+24u,0x1f80u,4u);
            for(pl_u32 k=0u;k<8u;++k){put(input+32u+k*16u,0x8000000000000000ull+k,8u);put(input+40u+k*16u,0x3fffu,2u);}
            if(!load){put(input+32u,a->significand,8u);put(input+40u,a->se,2u);}
            integers[row]=0x5a5a5a5a5a5a5a5aull;put(code+4096u,integers[row],8u);
            if(load){const pl_u64 binary32[]={0u,0x80000000u,0x3f800000u,0xbf800000u,1u,0x80000001u,0x7fffffu,0x800000u,
                    0x7f7fffffu,0xff7fffffu,0x7f800000u,0xff800000u,0x7fc00001u,0xffc00001u,0x7f800001u,0xff800001u};
                const pl_u64 binary64[]={0u,0x8000000000000000ull,0x3ff0000000000000ull,0xbff0000000000000ull,1u,0x8000000000000001ull,
                    0xfffffffffffffull,0x10000000000000ull,0x7fefffffffffffffull,0xffefffffffffffffull,0x7ff0000000000000ull,0xfff0000000000000ull,
                    0x7ff8000000000001ull,0xfff8000000000001ull,0x7ff0000000000001ull,0xfff0000000000001ull};
                integers[row]=bytes==4u?binary32[row&15u]:binary64[row&15u];put(code+4096u,integers[row],8u);}
            machine_state *first=records[row],*last=first+1u;memset(first,0,sizeof *first);
            for(pl_u32 r=0u;r<16u;++r)first->registers[r]=0x123456789abc0000ull+r;
            first->rip=0x400000u;first->rflags=0xa92u|(row&1u)|((row&2u)<<1u);first->cr0=0x80010031u;first->cr3=0x1000u;first->cr4=32u;
            first->efer=0xd00u;first->retired=42u;first->system[MACHINE_SYSTEM_CS]=19u;first->system[MACHINE_SYSTEM_DR0+7u]=0x400u;*last=*first;
            check_x87_hardware(first,last,code,input,before,after);check_x87_project(first,before);check_x87_project(last,after);
            if(last->x87_ip==(pl_u64)(uintptr_t)code)last->x87_ip=first->rip;
            if(last->x87_dp==(pl_u64)(uintptr_t)(code+4096u))last->x87_dp=first->rip+4096u;
            memcpy(written+row,code+4096u,8u);last->rip+=6u;++last->retired;++observed;
            if(last->x87_status&0x80u){++pending;kept+=written[row]==integers[row];}
        }
        char json[320];int n=snprintf(json,sizeof json,"{\"entry\":\"4194304\",\"sourceBytes\":6,\"stateBytes\":%zu,\"native\":64,\"bytes\":%u,\"store\":%s,\"operandOffset\":4096,\"pc\":%u,\"rc\":%u,\"unmask\":%u,\"pop\":%u,\"truncate\":%u}\n",sizeof(machine_state),bytes,load?"false":"true",pc,rc,mask,!load&&encoding>=2u,!load&&encoding>=5u);
        if(n<1||(size_t)n>=sizeof json||save(dir,form,"json",json,(size_t)n)||save(dir,form,"source",code,6u)
            ||save(dir,form,"cases",records,64u*sizeof records[0])||save(dir,form,"integers",integers,64u*sizeof integers[0])
            ||save(dir,form,"written",written,sizeof written))return 1;
    }
    printf("{\"format\":\"native-x87-%s-v1\",\"status\":\"observed\",\"forms\":%u,\"rows\":%u,\"unmaskedPending\":%u,\"pendingKeptMemory\":%u}\n",load?"ieee-load":"integer-store",forms,observed,pending,kept);return 0;
}
#endif
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    int register_divide=argc==3&&!strcmp(argv[2],"--register-divide");
    int register_multiply=argc==3&&!strcmp(argv[2],"--register-multiply");
    int register_mode=register_multiply||register_divide||(argc==3&&!strcmp(argv[2],"--register"));
    int division_mode=argc==3&&!strcmp(argv[2],"--divide");
    int memory_multiply=argc==3&&!strcmp(argv[2],"--memory-multiply"),multiply_mode=argc==3&&!strcmp(argv[2],"--multiply");
    int memory_mode=memory_multiply||(argc==3&&!strcmp(argv[2],"--memory"));
    int store_mode=argc==3&&!strcmp(argv[2],"--store");
    int load_mode=argc==3&&!strcmp(argv[2],"--load");
    if(argc>3||(argc==3&&!register_mode&&!division_mode&&!memory_mode&&!multiply_mode&&!store_mode&&!load_mode))return 2;
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
    if(store_mode||load_mode){int result=observe_store(dir,code,load_mode);if(!VirtualFree(code,0u,MEM_RELEASE))result=1;return result;}
    if(register_mode){int result=observe_register(dir,code,register_multiply?2:register_divide);if(!VirtualFree(code,0u,MEM_RELEASE))result=1;return result;}
    const pl_u32 masks[]={0u,1u,2u,8u,16u,32u},division_masks[]={0u,1u,2u,4u,8u,16u,32u},groups[]={4u,0u,5u};
    pl_u32 forms=(memory_multiply||multiply_mode)?224u:memory_mode?1120u:division_mode?448u:576u,
        operations=(memory_multiply||multiply_mode)?1u:memory_mode?5u:division_mode?2u:3u,per_form=(division_mode||memory_mode||multiply_mode)?128u:64u;
    if(division_mode)record_prefix="x87-division";
    if(memory_mode)record_prefix="x87-memory-arithmetic";
    if(memory_multiply)record_prefix="x87-memory-multiply";
    if(multiply_mode)record_prefix="x87-integer-multiply";
    pl_u32 rows=0u,changed=0u,pending=0u,published_pending=0u;int failed=1;
    for(pl_u32 form=0u;form<forms;++form){pl_u32 width=memory_mode?((form&1u)?8u:4u):(form&1u)?2u:4u,operation=(form/2u)%operations;
        pl_u32 mode=form/(2u*operations),pc=mode&3u,rc=(mode>>2u)&3u,mask=(division_mode||memory_mode||multiply_mode)?division_masks[mode>>4u]:masks[mode>>4u];DWORD previous;
        if(!VirtualProtect(code,4096u,PAGE_READWRITE,&previous))goto done;
        code[0]=(pl_u8)(memory_mode?(width==4u?0xd8u:0xdcu):(width==4u?0xdau:0xdeu));
        pl_u32 memory_groups[]={0u,4u,5u,6u,7u};code[1]=(pl_u8)((((multiply_mode||memory_multiply)?1u:memory_mode?memory_groups[operation]:division_mode?(operation?6u:7u):groups[operation])<<3u)|5u);
        put(code+2u,4090u,4u);code[6u]=0xc3u;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&previous)||!FlushInstructionCache(GetCurrentProcess(),code,7u))goto done;
        for(pl_u32 row=0u;row<per_form;++row){const operand *value=values+(row&15u);pl_u32 top=row&7u;
            _Alignas(16) pl_u8 input[512]={0},before[512],after[512];
            put(input,(0x7fu|(pc<<8u)|(rc<<10u))&~mask,2u);put(input+2u,0x4700u|(top<<11u),2u);
            input[4u]=(pl_u8)(value->empty?255u&~(1u<<top):255u);put(input+6u,0x123u,2u);
            put(input+8u,0x12340000u,8u);put(input+16u,0x56780000u,8u);put(input+24u,0x1f80u,4u);
            for(pl_u32 k=0u;k<8u;++k){put(input+32u+k*16u,0x8000000000000000ull+k,8u);put(input+40u+k*16u,0x3fffu,2u);}
            put(input+32u,value->significand,8u);put(input+40u,value->se,2u);
            pl_u32 which=row>>4u;pl_u64 x=which==0u?0u:which==1u?1u:which==2u?~0ull:
                (row&1u)?(1ull<<(width*8u-1u))-1u:1ull<<(width*8u-1u);
            if(division_mode||multiply_mode){const pl_u64 operands[]={0u,1u,~0ull,3u,~2ull,7u,
                (1ull<<(width*8u-1u))-1u,1ull<<(width*8u-1u)};x=operands[which];}
            if(memory_mode){const pl_u64 binary32[]={0u,0x80000000u,0x3f800000u,0xbf800000u,1u,0x7f800000u,0x7fc00001u,0x7f800001u};
                const pl_u64 binary64[]={0u,0x8000000000000000ull,0x3ff0000000000000ull,0xbff0000000000000ull,1u,0x7ff0000000000000ull,0x7ff8000000000001ull,0x7ff0000000000001ull};
                x=width==4u?binary32[which]:binary64[which];}
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
        char json[320];int n=snprintf(json,sizeof json,"{\"entry\":\"4194304\",\"sourceBytes\":6,\"stateBytes\":%zu,\"native\":%u,\"bytes\":%u,\"operandOffset\":4096,\"pc\":%u,\"rc\":%u,\"operation\":%u,\"unmask\":%u,\"oracle\":\"physical Windows CPU\"}\n",sizeof(machine_state),per_form,width,pc,rc,operation,mask);
        if(n<1||(size_t)n>=sizeof json||save(dir,form,"json",json,(size_t)n)||save(dir,form,"cases",records,(size_t)per_form*sizeof records[0])
            ||save(dir,form,"integers",integers,(size_t)per_form*sizeof integers[0])||save(dir,form,"source",code,6u))goto done;
    }
    printf("{\"format\":\"native-x87-integer-%s-v1\",\"status\":\"observed\",\"forms\":%u,\"rows\":%u,\"payloadChanged\":%u,\"unmaskedPending\":%u,\"payloadChangedWhilePending\":%u,\"linuxBoot\":\"not-tested\"}\n",division_mode?"division":"arithmetic",forms,rows,changed,pending,published_pending);failed=0;
done:if(!VirtualFree(code,0u,MEM_RELEASE))failed=1;return failed;
#endif
}
