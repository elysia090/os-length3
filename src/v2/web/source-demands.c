/* Read-only VM metadata transport. Own private memory, no guest memory import,
 * instruction execution, source admission, device, clock or key capability. */
typedef unsigned int u32;
typedef unsigned long long u64;
extern u32 source_groups(void) __attribute__((import_module("source"),import_name("groups")));
extern u32 source_group(u32) __attribute__((import_module("source"),import_name("group")));
extern u64 source_word(u32) __attribute__((import_module("source"),import_name("word")));
static u64 seen[128],epochs[128],observations,reused;
static u32 ranks[8192];
u32 source_demands_abi(void){return 1u;}
u32 source_demands_data(void){return (u32)(unsigned long)ranks;}
u64 source_demands_observations(void){return observations;}
u64 source_demands_reused(void){return reused;}
void source_demands_reset(void){
    volatile u64 *words=seen,*stamps=epochs;
    for(u32 i=0;i<128u;++i){words[i]=0u;stamps[i]=0u;}
}
u32 source_demands_read(u32 low,u32 high,u32 capacity){
    const u64 epoch=((u64)high<<32u)|low;
    u32 count=0u,groups=source_groups();
    if(!capacity||capacity>8192u||!groups||groups>4u)return 0xffffffffu;
    for(u32 cohort=0u;cohort<groups;++cohort){
        u32 banks=source_group(cohort);
        while(banks){
            u32 group=cohort*32u+(u32)__builtin_ctz(banks);banks&=banks-1u;
            u64 bits=source_word(group),fresh=bits;++observations;
            if(epochs[group]==epoch)fresh&=~seen[group];
            else {seen[group]=0u;epochs[group]=epoch;}
            seen[group]|=bits;if(bits&&!fresh)++reused;
            while(fresh){
                u32 rank=group*64u+(u32)__builtin_ctzll(fresh);fresh&=fresh-1u;
                if(rank>=capacity||count>=8192u)return 0xffffffffu;
                ranks[count++]=rank;
            }
        }
    }
    return count;
}
