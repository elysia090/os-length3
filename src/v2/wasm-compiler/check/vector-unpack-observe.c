#include "x87-hardware.h"
#include <stdio.h>
#ifdef _WIN32
static machine_state records[128][2];static pl_u8 operands[128][16];
static const char *prefix="vector-unpack";
static void put(pl_u8 *at,pl_u64 x,unsigned n){for(unsigned i=0;i<n;++i)at[i]=(pl_u8)(x>>(8u*i));}
static int save(const char *dir,unsigned form,const char *suffix,const void *data,size_t size)
{char name[4096];int n=snprintf(name,sizeof name,"%s/%s-%u.%s",dir,prefix,form,suffix);if(n<1||(size_t)n>=sizeof name)return 1;
 FILE *f=fopen(name,"wbx");if(!f)return 1;int bad=fwrite(data,1,size,f)!=size;if(fclose(f))bad=1;return bad;}
#endif
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    int shuffle=argc==3&&!strcmp(argv[2],"--shuffle");
    if(argc!=2&&!shuffle)return 2;
    if(shuffle)prefix="vector-shuffle";
    pl_u8 *code=check_x87_allocate(8192u);if(!code)return 1;
    const pl_u8 opcodes[]={0x60,0x61,0x62,0x68,0x69,0x6a,0x6c,0x6d};unsigned form=0;
    unsigned native=shuffle?32u:128u;
    for(unsigned wide=0;wide<(shuffle?1u:2u);++wide)for(unsigned family=0;family<(shuffle?256u:wide?8u:6u);++family)for(unsigned role=0;role<3u;++role,++form){
        DWORD previous;if(!VirtualProtect(code,4096u,PAGE_READWRITE,&previous))return 1;
        unsigned n=0;if(wide)code[n++]=0x66;code[n++]=0x0f;code[n++]=shuffle?0x70:opcodes[family];
        code[n++]=(pl_u8)(role==2u?0x0du:role==1u?0xc9u:0xc8u);
        if(role==2u){put(code+n,4096u-n-4u-(shuffle?1u:0u),4u);n+=4u;}
        if(shuffle)code[n++]=(pl_u8)family;
        code[n]=0xc3;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&previous)||!FlushInstructionCache(GetCurrentProcess(),code,n+1u))return 1;
        for(unsigned row=0;row<native;++row){_Alignas(16) pl_u8 input[512]={0},before[512],after[512];pl_u16 tags[2];unsigned top=row&7u;
            put(input,0x37f,2);put(input+2,0x4700u|(top<<11u),2);input[4]=0x55;put(input+6,0x123,2);
            put(input+8,0x12340000,8);put(input+16,0x56780000,8);put(input+24,0x1f80,4);
            for(unsigned rank=0;rank<8;++rank){unsigned logical=(rank+8u-top)&7u;put(input+32+logical*16u,0x8123456789abcdefull+row*11u+rank*37u,8);put(input+40+logical*16u,0x3fffu+rank,2);}
            for(unsigned rank=0;rank<32;++rank)put(input+160+rank*8u,0xfedcba9876543210ull^((pl_u64)row*0x123456789abull+rank*37u),8);
            put(operands[row],0x5a9876543210fedcull^(row*0xabcdefull),8);put(operands[row]+8,0xa5fedcba98765432ull^(row*0xabcdefull),8);memcpy(code+4096,operands[row],16);
            machine_state *first=records[row],*last=first+1;memset(first,0,sizeof *first);
            for(unsigned rank=0;rank<16;++rank)first->registers[rank]=0xabcdef0123450000ull+rank;
            first->rip=0x400000;first->rflags=0xa92;first->cr0=0x80010031;first->cr3=0x1000;first->cr4=0x620;first->efer=0xd00;
            first->system[MACHINE_SYSTEM_CS]=19;first->system[MACHINE_SYSTEM_DR0+7]=0x400;first->retired=42;*last=*first;
            check_x87_hardware_full(first,last,code,input,before,after,tags);check_x87_project(first,before);check_x87_project(last,after);
            first->x87_tag=tags[0];last->x87_tag=tags[1];last->rip+=n;++last->retired;
        }
        unsigned bytes=role==2u?(shuffle?8u:wide?16u:family<3u?4u:8u):0u;char json[224];
        int j=snprintf(json,sizeof json,"{\"sourceBytes\":%u,\"stateBytes\":1256,\"native\":%u,\"bytes\":%u,\"operandOffset\":4096,\"operandStride\":16}\n",n,native,bytes);
        if(j<1||(size_t)j>=sizeof json||save(argv[1],form,"json",json,(size_t)j)||save(argv[1],form,"source",code,n)||save(argv[1],form,"cases",records,native*sizeof records[0])
            ||save(argv[1],form,"integers",operands,native*sizeof operands[0]))return 1;
    }
    if(!VirtualFree(code,0,MEM_RELEASE))return 1;
    printf("%s: %u forms / %u independent full-state observations\n",prefix,form,form*native);return 0;
#endif
}
