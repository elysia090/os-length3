#define _GNU_SOURCE
#include <machine/state.h>
#include <stdio.h>
#include <string.h>
#ifdef __linux__
#include <asm/ldt.h>
#include <sys/syscall.h>
#include <sys/mman.h>
#include <unistd.h>
enum { ROWS=1024 };
static machine_state records[ROWS][2];static pl_u64 descriptors[ROWS],words[ROWS];static pl_u16 selectors[ROWS];
static void put(pl_u8 *p,pl_u64 x,unsigned n){for(unsigned i=0u;i<n;++i)p[i]=(pl_u8)(x>>(i*8u));}
static pl_u64 get(const pl_u8 *p,unsigned n){pl_u64 v=0u;for(unsigned i=0u;i<n;++i)v|=(pl_u64)p[i]<<(i*8u);return v;}
static int save(const char *dir,unsigned form,const char *suffix,const void *data,size_t n)
{
    char name[4096];int m=snprintf(name,sizeof name,"%s/selector-query-%u.%s",dir,form,suffix);if(m<1||(size_t)m>=sizeof name)return 1;
    FILE *f=fopen(name,"wbx");if(!f)return 1;int bad=fwrite(data,1u,n,f)!=n;if(fclose(f))bad=1;return bad;
}
#endif
int main(int argc,char **argv)
{
#ifndef __linux__
    (void)argc;(void)argv;return 2;
#else
    if(argc!=2)return 2;
    pl_u8 *code=mmap(NULL,8192u,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);if(code==MAP_FAILED)return 1;
    unsigned form=0u;pl_u16 cs;__asm__ volatile("mov %%cs,%0":"=r"(cs));
    for(unsigned limit=0u;limit<2u;++limit)for(unsigned width=2u;width<=8u;width*=2u)for(unsigned memory=0u;memory<2u;++memory,++form){
        unsigned n=0u;if(mprotect(code,4096u,PROT_READ|PROT_WRITE))return 1;
        if(width!=4u)code[n++]=(pl_u8)(width==2u?0x66u:0x48u);
        code[n++]=0x0fu;code[n++]=(pl_u8)(limit?3u:2u);code[n++]=(pl_u8)(memory?5u:0xc2u);
        if(memory){put(code+n,4096u-n-4u,4u);n+=4u;}code[n]=0xc3u;
        if(mprotect(code,4096u,PROT_READ|PROT_EXEC))return 1;
        for(unsigned row=0u;row<ROWS;++row){const unsigned entries[]={0u,3u,15u,63u};unsigned index=entries[(row>>8u)&3u];
            struct user_desc description={0};description.entry_number=index;description.base_addr=0x12345000u;
            description.limit=0xabcdeu;description.seg_32bit=(row>>7u)&1u;description.contents=((row/4u)%3u)&3u;
            description.read_exec_only=(row>>4u)&1u;description.limit_in_pages=(row>>6u)&1u;description.seg_not_present=(row>>5u)&1u;description.useable=1u;
            if(syscall(SYS_modify_ldt,1,&description,sizeof description))return 1;
            pl_u8 table[4096]={0};long copied=syscall(SYS_modify_ldt,0,table,sizeof table);if(copied<0||(unsigned long)copied<index*8u+8u)return 1;
            pl_u32 selector=(index<<3u)|4u|(row&3u);
            if(!(row&31u))selector=row&1u?3u:0u;
            else if((row&31u)==1u)selector=0xfff7u;
            descriptors[row]=selector==0xfff7u||!(selector&0xfffcu)?0u:get(table+index*8u,8u);
            selectors[row]=(pl_u16)selector;pl_u64 word=0x1234567800000000ull|selector;words[row]=word;put(code+4096u,selector,2u);
            pl_u64 seed=0xabcdef0123456789ull^((pl_u64)row<<17u),requested=0xa92u|(row&1u),out,first,last,host;
            __asm__ volatile("pushfq\n\tpopq %[host]\n\tpushq %[requested]\n\tpopfq\n\tpushfq\n\tpopq %[first]\n\tmov %[seed],%%rax\n\tmov %[word],%%rdx\n\tcall *%[code]\n\tmov %%rax,%[out]\n\tpushfq\n\tpopq %[last]\n\tpushq %[host]\n\tpopfq"
                :[host]"=&r"(host),[first]"=&r"(first),[out]"=&r"(out),[last]"=&r"(last)
                :[requested]"r"(requested),[seed]"r"(seed),[word]"r"(word),[code]"r"(code):"rax","rdx","memory","cc");
            machine_state *a=records[row],*b=a+1u;memset(a,0,sizeof *a);a->registers[0]=seed;a->registers[2]=word;
            a->rip=0x400000u;a->rflags=first;a->cr0=0x80010031u;a->cr3=0x1000u;a->cr4=32u;a->efer=0x500u;
            a->system[MACHINE_SYSTEM_CS]=cs;a->system[MACHINE_SYSTEM_DR0+7u]=0x400u;a->retired=42u;*b=*a;
            // Transport coordinates for a mirror of the observed LDT bytes,
            // not a claim that userspace measured the hidden kernel caches.
            a->system[MACHINE_SYSTEM_LDTR]=b->system[MACHINE_SYSTEM_LDTR]=0x50u;
            a->system[MACHINE_SYSTEM_GDTR_BASE]=b->system[MACHINE_SYSTEM_GDTR_BASE]=0x406000u;
            a->system[MACHINE_SYSTEM_GDTR_LIMIT]=b->system[MACHINE_SYSTEM_GDTR_LIMIT]=63u;
            b->registers[0]=out;b->rflags=last;b->rip+=n;++b->retired;
        }
        char json[256];int m=snprintf(json,sizeof json,"{\"sourceBytes\":%u,\"stateBytes\":%zu,\"native\":%u,\"bytes\":%u,\"operandOffset\":4096,\"limit\":%u,\"width\":%u}\n",n,sizeof(machine_state),ROWS,memory?2u:0u,limit,width);
        if(m<1||(size_t)m>=sizeof json||save(argv[1],form,"json",json,(size_t)m)||save(argv[1],form,"source",code,n)
            ||save(argv[1],form,"cases",records,sizeof records)||save(argv[1],form,"descriptors",descriptors,sizeof descriptors)
            ||save(argv[1],form,"selectors",selectors,sizeof selectors)||save(argv[1],form,"words",words,sizeof words))return 1;
    }
    if(munmap(code,8192u))return 1;
    printf("LAR/LSL: %u native forms/%u RAX/RFLAGS observations; actual Linux process LDT readback is independent of query results\n",form,form*ROWS);return 0;
#endif
}
