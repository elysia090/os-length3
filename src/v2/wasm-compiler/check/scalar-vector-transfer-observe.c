#include "x87-hardware.h"
#include <stdio.h>
#ifdef _WIN32
enum { ROWS=64 };
static machine_state records[ROWS][2];static pl_u64 operands[ROWS],written[ROWS];
static void put(pl_u8 *p,pl_u64 x,unsigned n){for(unsigned i=0u;i<n;++i)p[i]=(pl_u8)(x>>(i*8u));}
static pl_u64 get(const pl_u8 *p){pl_u64 x=0u;for(unsigned i=0u;i<8u;++i)x|=(pl_u64)p[i]<<(i*8u);return x;}
static pl_u64 random_word(pl_u64 *s){*s^=*s<<13u;*s^=*s>>7u;*s^=*s<<17u;return *s;}
static int save(const char *dir,unsigned form,const char *suffix,const void *data,size_t n)
{
    char name[4096];int m=snprintf(name,sizeof name,"%s/scalar-vector-transfer-%u.%s",dir,form,suffix);if(m<1||(size_t)m>=sizeof name)return 1;
    FILE *f=fopen(name,"wbx");if(!f)return 1;int bad=fwrite(data,1u,n,f)!=n;if(fclose(f))bad=1;return bad;
}
#endif
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    int half=argc==3&&!strcmp(argv[2],"--half"),shuffle=argc==3&&!strcmp(argv[2],"--shuffle-double"),align=argc==3&&!strcmp(argv[2],"--align");if(argc!=2&&!half&&!shuffle&&!align)return 2;
    pl_u8 *code=check_x87_allocate(8192u);if(!code)return 1;const pl_u8 coordinates[]={0u,5u,7u,9u,15u};
    unsigned form=0u;pl_u64 seed=0xde8911ce23ab5713ull;
    for(unsigned width=half||shuffle||align?8u:4u;width<=8u;width+=4u)for(unsigned direction=0u;direction<(align?256u:shuffle?8u:half?2u:4u);++direction)
    for(unsigned dst=0u;dst<(align?2u:5u);++dst)for(unsigned src=0u;src<(align?2u:shuffle||direction<2u?5u:1u);++src)for(unsigned prefix=0u;prefix<2u;++prefix,++form){
        unsigned memory=!align&&!shuffle&&direction>=2u,store=!align&&!shuffle&&direction==3u,target=coordinates[dst],source=memory?0u:coordinates[src],n=0u;DWORD old;
        if(!VirtualProtect(code,4096u,PAGE_READWRITE,&old))return 1;
        if(prefix)code[n++]=0x67u;
        if(shuffle||align)code[n++]=0x66u;else if(!half)code[n++]=(pl_u8)(width==4u?0xf3u:0xf2u);
        unsigned reg=align||shuffle||half||direction==0u||direction==2u?target:store?target:source,rm=align||shuffle||half||direction==0u?source:direction==1u?target:5u;
        unsigned rex=(reg>=8u?4u:0u)|(!memory&&rm>=8u?1u:0u);if(rex)code[n++]=(pl_u8)(0x40u|rex);
        code[n++]=0x0fu;if(align)code[n++]=0x3au;
        code[n++]=(pl_u8)(align?0x0fu:shuffle?0xc6u:half?(direction?0x16u:0x12u):direction==1u||store?0x11u:0x10u);code[n++]=(pl_u8)((memory?0u:0xc0u)|((reg&7u)<<3u)|(rm&7u));
        if(shuffle)code[n++]=(pl_u8)((direction&3u)|(direction>=4u?252u:0u));
        if(align)code[n++]=(pl_u8)direction;
        if(memory){put(code+n,4096u-n-4u,4u);n+=4u;}code[n]=0xc3u;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&old)||!FlushInstructionCache(GetCurrentProcess(),code,n+1u))return 1;
        for(unsigned row=0u;row<ROWS;++row){unsigned top=row&7u;_Alignas(16) pl_u8 input[512]={0},before[512],after[512];pl_u16 tags[2];
            pl_u64 value=random_word(&seed);operands[row]=value;put(code+4096u,value,8u);
            put(input,0x37fu,2u);put(input+2u,0x4700u|(top<<11u),2u);input[4]=(pl_u8)(row&8u?0x5au:255u);
            put(input+6u,0x123u,2u);put(input+8u,0x12340000u,8u);put(input+16u,0x56780000u,8u);put(input+24u,0x1f80u|(row&3u)<<13u|(row&16u?0x8040u:0u),4u);
            for(unsigned r=0u;r<8u;++r){unsigned logical=(r+8u-top)&7u;put(input+32u+logical*16u,random_word(&seed),8u);put(input+40u+logical*16u,0x3fffu,2u);}
            for(unsigned r=0u;r<32u;++r)put(input+160u+r*8u,random_word(&seed),8u);
            machine_state *a=records[row],*b=a+1u;memset(a,0,sizeof *a);for(unsigned r=0u;r<16u;++r)a->registers[r]=0xabcdef0123450000ull+r;
            a->rip=0x400000u;a->rflags=0xa92u|(row&1u);a->cr0=0x80010031u;a->cr3=0x1000u;a->cr4=1568u;a->efer=0xd00u;
            a->system[MACHINE_SYSTEM_CS]=19u;a->system[MACHINE_SYSTEM_DR0+7u]=0x400u;a->retired=42u;*b=*a;
            check_x87_hardware_full(a,b,code,input,before,after,tags);check_x87_project(a,before);check_x87_project(b,after);a->x87_tag=tags[0];b->x87_tag=tags[1];
            written[row]=get(code+4096u);b->rip+=n;++b->retired;
        }
        char json[256];int m=snprintf(json,sizeof json,"{\"sourceBytes\":%u,\"stateBytes\":%zu,\"native\":%u,\"bytes\":%u,\"operandOffset\":4096,\"store\":%u,\"writtenStride\":8}\n",n,sizeof(machine_state),ROWS,memory?width:0u,store);
        if(m<1||(size_t)m>=sizeof json||save(argv[1],form,"json",json,(size_t)m)||save(argv[1],form,"source",code,n)
            ||save(argv[1],form,"cases",records,sizeof records)||save(argv[1],form,"integers",operands,sizeof operands)||(store&&save(argv[1],form,"written",written,sizeof written)))return 1;
    }
    if(!VirtualFree(code,0u,MEM_RELEASE))return 1;
    printf("%s: %u forms/%u complete FP/MXCSR/tag/flags/memory rows\n",align?"PALIGNR":shuffle?"SHUFPD":half?"MOVHLPS/MOVLHPS":"MOVSS/MOVSD",form,form*ROWS);return 0;
#endif
}
