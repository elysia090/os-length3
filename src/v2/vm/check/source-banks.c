#include <vm/source-banks.h>
#include <stdio.h>
#include <string.h>
static vm_source_banks banked;
static vm_sources reference[VM_SOURCE_BANKS],small;
static pl_u64 entries[1024];
static pl_u32 counts[VM_SOURCE_BANKS],seed=0x59163a2fu;
static int failures;
#define EXPECT(x) do{if(!(x)){fprintf(stderr,"source banks:%u: %s\n",(unsigned)__LINE__,#x);++failures;}}while(0)
static pl_u32 random_word(void){seed^=seed<<13u;seed^=seed>>17u;seed^=seed<<5u;return seed;}
static vm_code_page page_for(pl_u64 entry)
{return (vm_code_page){.address=entry&~4095ull,.generation=11u,.offset=4096u,.bytes=4096u};}
static int probe(pl_u64 entry)
{
    vm_sources *s=vm_source_banks_select(&banked,entry);pl_u32 b=banked.active;
    vm_code_page page=page_for(entry);vm_execution_row a={0},r={0};
    int status=vm_sources_probe(s,&page,entry,16u,&a),other=vm_sources_probe(reference+b,&page,entry,16u,&r);
    EXPECT(status==other);EXPECT(!memcmp(&a,&r,sizeof a));
    if(status==1){EXPECT(!vm_sources_publish(s,3u,1u,0u,&a));
        EXPECT(!vm_sources_publish(reference+b,3u,1u,0u,&r));vm_source_banks_published(&banked);}
    EXPECT(!memcmp(s,reference+b,sizeof *s));return status;
}
int main(void)
{
    vm_source_banks_open(&banked,11u,5u);vm_sources_open(&small,11u,5u);
    for(pl_u32 b=0u;b<VM_SOURCE_BANKS;++b)vm_sources_open(reference+b,11u,5u+b*VM_SOURCE_ROWS);
    EXPECT(vm_source_banks_empty(&banked));pl_u32 n=0u;
    for(pl_u64 entry=0x400000u;n<1024u;entry+=8u){vm_source_banks_select(&banked,entry);
        if(counts[banked.active]>=32u)continue;
        ++counts[banked.active];entries[n++]=entry;}
    pl_u32 cold=0u,warm=0u,small_misses=0u;
    for(pl_u32 i=0u;i<1024u;++i)cold+=(pl_u32)(probe(entries[i])==1);
    for(pl_u32 round=0u;round<16u;++round)for(pl_u32 i=0u;i<1024u;++i){
        warm+=(pl_u32)(probe(entries[i])==0);vm_code_page page=page_for(entries[i]);vm_execution_row row;
        if(vm_sources_probe(&small,&page,entries[i],16u,&row)==1){++small_misses;EXPECT(!vm_sources_publish(&small,3u,1u,0u,&row));}}
    EXPECT(cold==1024u&&warm==16384u&&small_misses==16384u);
    EXPECT(!vm_source_banks_empty(&banked));
    // Direct all-bank invalidation is the deliberately slow reference. The
    // production watcher may visit only candidates, but cannot miss an exact
    // extent, a pending source, same-byte rewrite, or a watcher-bucket alias.
    for(pl_u32 turn=0u;turn<131072u;++turn){
        pl_u32 rank=random_word()%1024u;probe(entries[rank]);
        pl_u32 offset=(turn&3u)?4096u+(pl_u32)(entries[random_word()%1024u]&4095u):0x101000u;
        pl_u32 bytes=(turn&127u)?1u:1048576u;
        vm_source_banks_write(&banked,offset,bytes);
        for(pl_u32 b=0u;b<VM_SOURCE_BANKS;++b){vm_sources_write(reference+b,offset,bytes);
            EXPECT(!memcmp(banked.banks+b,reference+b,sizeof(vm_sources)));}
    }
    vm_sources *s=vm_source_banks_select(&banked,entries[0]);vm_code_page page=page_for(entries[0]);vm_execution_row row;
    vm_sources_open(s,11u,s->first_slot);EXPECT(vm_sources_probe(s,&page,entries[0],16u,&row)==1);
    vm_source_banks_write(&banked,4096u,4096u);EXPECT(!s->pending);EXPECT(vm_sources_publish(s,3u,1u,0u,&row)==-1);
    vm_source_banks_open(&banked,12u,5u);EXPECT(vm_source_banks_empty(&banked));
    printf("source banks: %u cold/%u warm; old64 %u misses; 131072 all-bank physical invalidation comparisons; %u failures\n",cold,warm,small_misses,(unsigned)failures);
    return failures!=0;
}
