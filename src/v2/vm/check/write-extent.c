#include <vm/mmu.h>
#include <stdio.h>
#include <string.h>

static _Alignas(8) pl_u8 arena[65536], expected[8192];
static vm_memory memory;
static vm_memory_page pages[6];
static vm_memory_branch branches[5];
static const pl_u32 port=2048u, payload=28672u, leaf=20480u;
static const pl_u64 base=0x400000u;
static pl_u32 observed, failures;
#define EXPECT(x) do { if (!(x)) { if(failures<20u)fprintf(stderr,"write-extent: %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static void put(pl_u32 at,pl_u64 value)
{ for(pl_u32 i=0u;i<8u;++i)arena[at+i]=(pl_u8)(value>>(i*8u)); }
static vm_mmu_context context(void)
{ return (vm_mmu_context){0x80010001ull,0x1000u,32u,0xd00u,0u}; }
static void watch(void *owner,pl_u32 offset,pl_u32 bytes)
{
    EXPECT(owner==&memory && bytes && bytes<=8u);
    EXPECT(offset>=8192u && (pl_u64)offset+bytes<=sizeof arena);
    observed+=bytes;
}
static void reset(void)
{
    memset(arena,0,sizeof arena); put(port,9u);
    for(pl_u32 i=0u;i<4u;++i) {
        pages[i]=(vm_memory_page){(i+1ull)*4096u,(i+2u)*4096u,3u,VM_MEMORY_RAM,0u,0u};
        put(pages[i].offset+(i==2u ? 16u : 0u), (i==3u ? 0x8000ull : (i+2ull)*4096u)|0x67u);
    }
    pages[4]=(vm_memory_page){0x8000u,payload,3u,VM_MEMORY_RAM,0u,0u};
    pages[5]=(vm_memory_page){0x9000u,payload+4096u,3u,VM_MEMORY_RAM,0u,0u};
    put(leaf+8u,0x9067u);
    for(pl_u32 i=0u;i<8192u;++i)arena[payload+i]=expected[i]=(pl_u8)(i*17u+29u);
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,pages,6u,6u,branches,9u));
    memory.before_write=watch; memory.write_owner=&memory; observed=0u;
}
int main(void)
{
    pl_u32 comparisons=0u;
    EXPECT(sizeof(vm_memory_reservation)==56u);
    /* Every page offset, both single and split words, sparse untouched bytes
     * and all widths. The expected array is test-only, not a runtime image. */
    for(pl_u32 row=0u;row<4096u;++row) {
        reset(); vm_mmu_context cpu=context();
        pl_u32 length=1u+(row*251u)%512u;
        machine_result begin=vm_mmu_write_begin(&memory,port,&cpu,base+row,length,MACHINE_MEMORY_WRITE);
        if(begin) { machine_memory_port out; memcpy(&out,arena+port,sizeof out);
            fprintf(stderr,"begin row=%u bytes=%u result=%llu fault=%llx/%u/%u ptes=%x %x\n",row,length,(unsigned long long)begin,
                (unsigned long long)out.fault_address,out.fault_vector,out.fault_error,arena[leaf],arena[leaf+8u]); return 1; }
        EXPECT(observed==0u && !memory.write_touched);
        for(pl_u32 at=0u;at<length;) {
            pl_u32 width=1u+(at+row)%8u; if(width>length-at)width=length-at;
            pl_u64 value=0xeeddbbccaa997766ull^(row+at);
            EXPECT(!vm_memory_write_word(&memory,port,at,width,value));
            for(pl_u32 byte=0u;byte<width;++byte)expected[row+at+byte]=(pl_u8)(value>>(byte*8u));
            at+=width;
            if(at<length)++at; /* Deliberate preserved hole. */
            ++comparisons;
        }
        EXPECT(!vm_memory_write_end(&memory,port));
        EXPECT(!memcmp(arena+payload,expected,sizeof expected) && !memory.reservation.parts);
        EXPECT(vm_memory_write_end(&memory,port)==MACHINE_RESULT_ENTRY_MAP);
    }
    /* Failure on the second page never publishes the first fragment. */
    for(pl_u32 mode=0u;mode<11u;++mode) {
        reset(); vm_mmu_context cpu=context(); pl_u64 address=base+4080u;
        if(mode==0u)put(leaf+8u,0u);
        if(mode==1u)put(leaf+8u,0x9065u);
        if(mode==2u)pages[5].kind=VM_MEMORY_DEFERRED;
        if(mode==3u)pages[5].rights=MACHINE_MEMORY_READ;
        if(mode==4u)put(port,8u);
        if(mode==5u)cpu.cr4|=1ull<<12u;
        if(mode==6u)address=0x800000000000ull;
        if(mode==7u)address=~15ull;
        if(mode==8u)++address;
        pl_u32 length=mode==9u ? 0u : mode==10u ? 513u : 512u;
        machine_result result=vm_mmu_write_begin(&memory,port,&cpu,address,length,
            MACHINE_MEMORY_WRITE|VM_MMU_ALIGNED16);
        EXPECT(result && !memory.reservation.parts && observed==0u);
        EXPECT(!memcmp(arena+payload,expected,sizeof expected));
        EXPECT(vm_memory_write_word(&memory,port,0u,8u,0u)!=0u);
        if(mode<2u) {
            machine_memory_port output; memcpy(&output,arena+port,sizeof output);
            EXPECT(machine_result_kind(result)==MACHINE_RESULT_FAULT && output.fault_vector==14u);
            EXPECT(output.fault_address==base+4096u && output.fault_error==(mode==0u ? 2u : 3u));
        }
    }
    for(pl_u32 mode=0u;mode<8u;++mode) {
        reset(); vm_mmu_context cpu=context();
        EXPECT(!vm_mmu_write_begin(&memory,port,&cpu,base,512u,MACHINE_MEMORY_WRITE));
        EXPECT(!vm_memory_write_word(&memory,port,0u,8u,0u));
        if(mode==0u)vm_memory_abort(&memory);
        if(mode==1u)put(port,8u);
        if(mode==2u)EXPECT(!vm_mmu_access(&memory,port,&cpu,base+64u,8u,MACHINE_MEMORY_READ,0u));
        if(mode==3u)EXPECT(vm_memory_commit(&memory,port,0u)==MACHINE_RESULT_ENTRY_MAP);
        if(mode==4u)EXPECT(vm_memory_write_word(&memory,port,0u,8u,1u)==MACHINE_RESULT_ENTRY_MAP);
        if(mode==5u)EXPECT(vm_memory_write_word(&memory,port,512u,1u,1u)==MACHINE_RESULT_ENTRY_MAP);
        if(mode==6u)EXPECT(vm_memory_write_word(&memory,port,8u,9u,1u)==MACHINE_RESULT_ENTRY_MAP);
        if(mode==7u)EXPECT(vm_memory_write_word(&memory,port,8u,0u,1u)==MACHINE_RESULT_ENTRY_MAP);
        EXPECT(vm_memory_write_word(&memory,port,8u,8u,1u)!=0u && !memory.reservation.parts);
        EXPECT(observed==8u); /* Earlier output is not rolled back. */
    }
    /* Writes can alias the leaf which authorized them. The original
     * destinations remain pinned; there is no walk between output words. */
    reset(); vm_mmu_context cpu=context(); put(leaf,0x4067u);
    EXPECT(!vm_mmu_write_begin(&memory,port,&cpu,base,64u,MACHINE_MEMORY_WRITE));
    EXPECT(!vm_memory_write_word(&memory,port,0u,8u,0u));
    EXPECT(!vm_memory_write_word(&memory,port,8u,8u,0x0123456789abcdefull));
    EXPECT(!vm_memory_write_end(&memory,port) && observed==16u);
    EXPECT(arena[leaf]==0u && arena[leaf+8u]==0xefu);
    reset(); cpu=context(); pages[4].kind=VM_MEMORY_ROM; pages[5].kind=VM_MEMORY_ROM;
    EXPECT(!vm_mmu_write_begin(&memory,port,&cpu,base+4080u,512u,MACHINE_MEMORY_WRITE));
    EXPECT(!vm_memory_write_word(&memory,port,8u,8u,0u));
    EXPECT(!vm_memory_write_word(&memory,port,16u,8u,0u));
    EXPECT(!vm_memory_write_end(&memory,port) && observed==0u && !memory.write_touched);
    EXPECT(!memcmp(arena+payload,expected,sizeof expected));
    if(failures)return 1;
    printf("Sparse write extent: %u ordered word comparisons; two-fragment/fault/wait/stale/abort/alias/ROM models green\n",comparisons);
    return 0;
}
