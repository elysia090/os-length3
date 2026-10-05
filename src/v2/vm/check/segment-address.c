#include <vm/segments.h>
#include <assert.h>
#include <stdio.h>
int main(void)
{
    machine_segments segments={.version=MACHINE_SEGMENTS_ABI_VERSION};
    segments.cache[MACHINE_SEGMENT_CS].attributes=0xa09bu;
    segments.cache[MACHINE_SEGMENT_FS].attributes=MACHINE_SEGMENT_UNUSABLE;
    segments.cache[MACHINE_SEGMENT_GS].attributes=MACHINE_SEGMENT_UNUSABLE;
    const pl_u64 bases[]={0u,0x500000u,0x100500000ull,0x7ffffffff000ull,0xffff800000000000ull};
    const pl_u64 offsets[]={0u,1u,0xffffffffu,0x100000000ull,~0ull,0xfffffffffff00200ull};
    unsigned checked=0u;
    for(unsigned rank=MACHINE_SEGMENT_FS;rank<=MACHINE_SEGMENT_GS;++rank)
    for(unsigned base=0u;base<5u;++base)for(unsigned offset=0u;offset<6u;++offset)
    for(unsigned kind=1u;kind<=3u;++kind){
        segments.cache[rank].base=bases[base];
        pl_u64 address=offsets[offset];pl_u32 access=kind|(rank==MACHINE_SEGMENT_FS?MACHINE_MEMORY_FS:MACHINE_MEMORY_GS);
        assert(!vm_segment_address(&segments,&address,&access));
        assert(address==bases[base]+offsets[offset]&&access==kind);++checked;
    }
    for(unsigned mode=0u;mode<8u;++mode){
        machine_segments invalid=segments;pl_u64 address=123u;pl_u32 access=MACHINE_MEMORY_READ|MACHINE_MEMORY_FS;
        if(mode==0u)access|=MACHINE_MEMORY_GS;
        if(mode==1u)access|=MACHINE_MEMORY_STACK;
        if(mode==2u)invalid.version=0u;
        if(mode==3u)invalid.interrupt_shadow=3u;
        if(mode==4u)invalid.cache[MACHINE_SEGMENT_CS].attributes|=MACHINE_SEGMENT_UNUSABLE;
        if(mode==5u)invalid.cache[MACHINE_SEGMENT_CS].attributes|=0x4000u;
        if(mode==6u)invalid.cache[MACHINE_SEGMENT_FS].base=0x800000000000ull;
        if(mode==7u)access|=VM_MMU_EXECUTE;
        pl_u32 original=access;
        assert(vm_segment_address(&invalid,&address,&access)==-1&&address==123u&&access==original);++checked;
    }
    pl_u64 address=123u;pl_u32 access=MACHINE_MEMORY_READ;
    assert(!vm_segment_address(NULL,&address,&access)&&address==123u&&access==MACHINE_MEMORY_READ);
    access|=MACHINE_MEMORY_FS;assert(vm_segment_address(NULL,&address,&access)==-1&&address==123u);
    assert(vm_segment_address(&segments,NULL,&access)==-1&&vm_segment_address(&segments,&address,NULL)==-1);
    printf("Segment address: %u substitutions/refusals; null-selector bases, wrap and linear pass-through\n",checked);
    return 0;
}
