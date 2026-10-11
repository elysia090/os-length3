#include <vm/source-banks.h>
#include <stdio.h>
#include <string.h>
static vm_source_banks banked;
static vm_sources reference[VM_SOURCE_BANKS],small;
#define POPULATION (VM_SOURCE_CAPACITY / 2u)
static pl_u64 entries[POPULATION];
static pl_u32 counts[VM_SOURCE_BANKS],seed=0x59163a2fu;
static int failures;
#define EXPECT(x) do{if(!(x)){fprintf(stderr,"source banks:%u: %s\n",(unsigned)__LINE__,#x);++failures;}}while(0)
static pl_u32 random_word(void){seed^=seed<<13u;seed^=seed>>17u;seed^=seed<<5u;return seed;}
static vm_code_page page_for(pl_u64 entry)
{return (vm_code_page){.address=entry&~4095ull,.generation=11u,.offset=4096u+(pl_u32)((entry-0x400000u)&~4095ull),.bytes=4096u};}
static int probe(pl_u64 entry)
{
    vm_code_page page=page_for(entry);
    vm_sources *s=vm_source_banks_select(&banked,entry,page.offset);pl_u32 b=banked.active;vm_execution_row a={0},r={0};
    int status=vm_sources_probe(s,&page,entry,16u,&a),other=vm_sources_probe(reference+b,&page,entry,16u,&r);
    EXPECT(status==other);EXPECT(!memcmp(&a,&r,sizeof a));
    if(status==1){EXPECT(!vm_sources_publish(s,3u,1u,0u,&a));
        EXPECT(!vm_sources_publish(reference+b,3u,1u,0u,&r));vm_source_banks_published(&banked);}
    EXPECT(!memcmp(s,reference+b,sizeof *s));return status;
}
static void compare_write(pl_u32 offset,pl_u32 bytes)
{
    vm_source_banks_write(&banked,offset,bytes);
    for(pl_u32 b=0u;b<VM_SOURCE_BANKS;++b){vm_sources_write(reference+b,offset,bytes);
        EXPECT(!memcmp(banked.banks+b,reference+b,sizeof(vm_sources)));}
}
static void page_frontier(void)
{
    /* New fixtures start with equal inactive scratch as well as equal live
     * rows; open deliberately need not erase unused row payloads. */
    memset(&banked,0,sizeof banked);memset(reference,0,sizeof reference);
    vm_source_banks_open(&banked,11u,5u);
    for(pl_u32 b=0u;b<VM_SOURCE_BANKS;++b)vm_sources_open(reference+b,11u,5u+b*VM_SOURCE_ROWS);
    /* Both ends of a noncontiguous crossing may be unpublished. A zero page
     * bitmap must never hide a write that cancels that reservation. */
    vm_code_page first={0x400000u,11u,4096u,4096u},tail={0x401000u,11u,0xfffff000u,4096u};
    vm_execution_row a={0},r={0};
    vm_sources *s=vm_source_banks_select(&banked,0x400fffu,first.offset);
    vm_sources *ref=reference+banked.active;
    EXPECT(vm_sources_probe(s,&first,0x400fffu,16u,&a)==1);
    EXPECT(vm_sources_probe(ref,&first,0x400fffu,16u,&r)==1);
    EXPECT(vm_sources_extend(s,&tail,&a)==1);EXPECT(vm_sources_extend(ref,&tail,&r)==1);
    compare_write(tail.offset,1u);EXPECT(!s->pending);
    EXPECT(vm_sources_publish(s,3u,1u,0u,&a)==-1);
    EXPECT(vm_sources_probe(s,&first,0x400fffu,16u,&a)==1);
    EXPECT(vm_sources_probe(ref,&first,0x400fffu,16u,&r)==1);
    EXPECT(vm_sources_extend(s,&tail,&a)==1);EXPECT(vm_sources_extend(ref,&tail,&r)==1);
    EXPECT(!vm_sources_publish(s,3u,1u,0u,&a));EXPECT(!vm_sources_publish(ref,3u,1u,0u,&r));
    vm_source_banks_published(&banked);
    /* Page/word boundaries, a lower-eight-bit alias, final physical page and
     * an overflow extent must all retain the old exact invalidation result. */
    const pl_u32 offsets[]={0u,0x3ffffu,0x40000u,0x101000u,0xfffffff0u,0xfffff000u};
    const pl_u32 sizes[]={1u,2u,4096u,1u,32u,1u};
    for(pl_u32 i=0u;i<sizeof offsets/sizeof offsets[0];++i)compare_write(offsets[i],sizes[i]);
    EXPECT(!s->valid);

    /* Two full publication epochs replace old pages. Rebuild must remove
     * dead positives while retaining every current source page. */
    vm_source_banks_open(&banked,11u,5u);
    for(pl_u32 i=0u;i<2u*VM_SOURCE_CAPACITY;++i){
        pl_u64 entry=0x400000ull+(pl_u64)i*4096u;
        vm_code_page page={entry,11u,(i+1u)*4096u,4096u};
        s=vm_source_banks_select(&banked,entry,page.offset);
        EXPECT(vm_sources_probe(s,&page,entry,16u,&a)==1);
        EXPECT(!vm_sources_publish(s,3u,1u,0u,&a));vm_source_banks_published(&banked);
    }
    EXPECT(!banked.publications);pl_u32 pages=0u;
    for(pl_u32 word=0u;word<VM_SOURCE_PAGE_WORDS;++word)pages+=(pl_u32)__builtin_popcountll(banked.pages[word]);
    EXPECT(pages==VM_SOURCE_CAPACITY);
    for(pl_u32 b=0u;b<VM_SOURCE_BANKS;++b){pl_u64 valid=banked.banks[b].valid;
        while(valid){pl_u32 rank=(pl_u32)__builtin_ctzll(valid);valid&=valid-1u;
            pl_u32 page=banked.banks[b].rows[rank].offset>>12u;
            EXPECT((banked.pages[page>>6u]&(1ull<<(page&63u)))!=0u);}}
    EXPECT(!(banked.pages[0]&2u));
}
int main(void)
{
    vm_source_banks_open(&banked,11u,5u);vm_sources_open(&small,11u,5u);
    for(pl_u32 b=0u;b<VM_SOURCE_BANKS;++b)vm_sources_open(reference+b,11u,5u+b*VM_SOURCE_ROWS);
    EXPECT(vm_source_banks_empty(&banked));pl_u32 n=0u;
    for(pl_u64 entry=0x400000u;n<POPULATION;entry+=8u){vm_source_banks_select(&banked,entry,page_for(entry).offset);
        if(counts[banked.active]>=32u)continue;
        ++counts[banked.active];entries[n++]=entry;}
    pl_u32 cold=0u,warm=0u,small_misses=0u;
    for(pl_u32 i=0u;i<POPULATION;++i)cold+=(pl_u32)(probe(entries[i])==1);
    for(pl_u32 round=0u;round<4u;++round)for(pl_u32 i=0u;i<POPULATION;++i){
        warm+=(pl_u32)(probe(entries[i])==0);vm_code_page page=page_for(entries[i]);vm_execution_row row;
        if(vm_sources_probe(&small,&page,entries[i],16u,&row)==1){++small_misses;EXPECT(!vm_sources_publish(&small,3u,1u,0u,&row));}}
    EXPECT(cold==POPULATION&&warm==4u*POPULATION&&small_misses==4u*POPULATION);
    EXPECT(!vm_source_banks_empty(&banked));
    // Direct all-bank invalidation is the deliberately slow reference. The
    // production watcher may visit only candidates, but cannot miss an exact
    // extent, a pending source, same-byte rewrite, or a watcher-bucket alias.
    for(pl_u32 turn=0u;turn<131072u;++turn){
        pl_u32 rank=random_word()%POPULATION;probe(entries[rank]);
        pl_u64 target=entries[random_word()%POPULATION];
        pl_u32 offset=(turn&3u)?page_for(target).offset+(pl_u32)(target&4095u):0x101000u;
        pl_u32 bytes=(turn&127u)?1u:1048576u;
        vm_source_banks_write(&banked,offset,bytes);
        for(pl_u32 b=0u;b<VM_SOURCE_BANKS;++b){vm_sources_write(reference+b,offset,bytes);
            EXPECT(!memcmp(banked.banks+b,reference+b,sizeof(vm_sources)));}
    }
    vm_sources *s=vm_source_banks_select(&banked,entries[0],page_for(entries[0]).offset);vm_code_page page=page_for(entries[0]);vm_execution_row row;
    vm_sources_open(s,11u,s->first_slot);EXPECT(vm_sources_probe(s,&page,entries[0],16u,&row)==1);
    vm_source_banks_write(&banked,4096u,4096u);EXPECT(!s->pending);EXPECT(vm_sources_publish(s,3u,1u,0u,&row)==-1);
    page_frontier();
    vm_source_banks_open(&banked,12u,5u);EXPECT(vm_source_banks_empty(&banked));
    printf("source banks: %u cold/%u warm; old64 %u misses; 131072 all-bank physical invalidation comparisons; unpublished/crossing/final-page/overflow and two publication epochs; %u failures\n",cold,warm,small_misses,(unsigned)failures);
    return failures!=0;
}
