#include <vm/mmu.h>
#include <vm/tables.h>
#include <vm/control.h>
#include <stdio.h>
#include <string.h>

static _Alignas(8) pl_u8 arena[65536], saved[65536];
static vm_memory memory;
static vm_memory_page pages[6];
static pl_u32 entries[4];
static const pl_u64 base = 0x400000u;
static const pl_u32 port = 2048u;
static int failures;
static vm_memory_branch branches[5];
#define EXPECT(x) do { if (!(x)) { fprintf(stderr, "mmu: line %u\n", (unsigned)__LINE__); ++failures; } } while (0)

static void put(pl_u32 at, pl_u64 value)
{ for (pl_u32 i = 0u; i < 8u; ++i) arena[at + i] = (pl_u8)(value >> (8u * i)); }
static pl_u64 get(pl_u32 at)
{
    pl_u64 value = 0u;
    for (pl_u32 i = 0u; i < 8u; ++i) value |= (pl_u64)arena[at + i] << (8u * i);
    return value;
}
static vm_mmu_context context(void)
{ return (vm_mmu_context){ 0x80010001ull, 0x1000u, 32u, 0xd00u, 0u }; }
static void reset(pl_u64 address)
{
    const pl_u32 shifts[] = {39u, 30u, 21u, 12u};
    memset(arena, 0, sizeof arena); put(port, 9u);
    for (pl_u32 i = 0u; i < 4u; ++i) {
        pages[i] = (vm_memory_page){ (i + 1ull) * 4096u, (i + 2u) * 4096u,
                                     3u, VM_MEMORY_RAM, 0u, 0u };
        entries[i] = pages[i].offset + (pl_u32)((address >> shifts[i]) & 511u) * 8u;
        put(entries[i], (i == 3u ? 0x8000u : (i + 2ull) * 4096u) | 7u);
    }
    pages[4] = (vm_memory_page){0x8000u, 28672u, 3u, VM_MEMORY_RAM, 0u, 0u};
    pages[5] = (vm_memory_page){0x9000u, 32768u, 3u, VM_MEMORY_RAM, 0u, 0u};
    put(entries[3] + 8u, 0x9007u);
    EXPECT(vm_memory_open(&memory, arena, sizeof arena, 4096u, pages, 6u, 6u, branches, 9u) == 0);
}
static machine_result access(vm_mmu_context *cpu, pl_u64 address, pl_u32 bytes, pl_u32 flags, pl_u64 value)
{ return vm_mmu_access(&memory, port, cpu, address, bytes, flags, value); }
static void expect_fault(machine_result result, pl_u64 address, pl_u32 vector, pl_u32 error)
{
    EXPECT(machine_result_kind(result) == MACHINE_RESULT_FAULT);
    EXPECT(machine_result_payload(result) == vector);
    EXPECT(get(port + 16u) == address);
    EXPECT(get(port + 24u) == ((pl_u64)error << 32u | vector));
}
static _Alignas(8) pl_u8 reference_arena[65536];
typedef struct {pl_u64 count,order;} write_observation;
static void observe_write(void *owner,pl_u32 offset,pl_u32 bytes)
{write_observation *o=owner;++o->count;o->order=o->order*65599u+offset+((pl_u64)bytes<<32u);}
static void walk_proof_models(void)
{
    unsigned comparisons=0u;
    for(unsigned pattern=0u;pattern<4u;++pattern)
    for(unsigned level=0u;level<4u;++level)for(unsigned mode=0u;mode<20u;++mode)
    for(unsigned role=0u;role<3u;++role)for(unsigned user=0u;user<2u;++user){
        reset(base);vm_mmu_context cpu=context();cpu.cpl=user?3u:0u;
        pl_u32 flags=role==0u?MACHINE_MEMORY_READ:role==1u?MACHINE_MEMORY_WRITE:MACHINE_MEMORY_READ|VM_MMU_EXECUTE;
        pl_u64 initial=pattern==0u?0u:pattern==1u?~0ull:pattern==2u?0x1122334455667788ull:0x8000000000000001ull;
        put(pages[4].offset,initial);put(pages[5].offset,~initial);
        EXPECT(!access(&cpu,base,8u,flags,initial));
        EXPECT(memory.walks[(base>>12u)&63u].depth==4u);
        pl_u64 entry=get(entries[level]),address=base;
        switch(mode){case 0u:break;case 1u:put(entries[level],entry&~32ull);break;
        case 2u:put(entries[level],entry&~64ull);break;case 3u:put(entries[level],entry&~1ull);break;
        case 4u:put(entries[level],entry&~4ull);break;case 5u:put(entries[level],entry&~2ull);break;
        case 6u:put(entries[level],entry|(1ull<<63u));break;case 7u:put(entries[level],entry|(1ull<<40u));break;
        case 8u:put(entries[level],entry|128u);break;case 9u:put(entries[level],0x9007u);break;
        case 10u:pages[level].rights=0u;break;case 11u:pages[level].kind=VM_MEMORY_DEFERRED;break;
        case 12u:pages[level].offset=pages[4].offset;break;case 13u:cpu.cr3=0x9000u;break;
        case 14u:cpu.cr0^=0x10000u;break;case 15u:cpu.cpl^=3u;break;
        case 16u:cpu.cr4|=1ull<<12u;break;case 17u:cpu.efer^=1ull<<11u;break;
        case 18u:address=base+1u;break;default:address=base+4092u;break;}
        memcpy(reference_arena,arena,sizeof arena);vm_memory reference=memory;reference.bytes=reference_arena;
        memset(reference.walks,0,sizeof reference.walks);
        write_observation observed[2]={{0},{0}};memory.before_write=observe_write;memory.write_owner=observed;
        reference.before_write=observe_write;reference.write_owner=observed+1u;
        machine_result actual=access(&cpu,address,8u,flags,~initial);
        machine_result expected=vm_mmu_access(&reference,port,&cpu,address,8u,flags,~initial);
        EXPECT(actual==expected);EXPECT(!memcmp(arena,reference_arena,sizeof arena));
        EXPECT(!memcmp(observed,observed+1u,sizeof *observed));
        EXPECT(!memcmp(&memory.reservation,&reference.reservation,sizeof memory.reservation));++comparisons;
    }
    printf("walk proof: %u cached/fresh whole-RAM/port/write-order comparisons; ancestor/control/access/cross-page mutation\n",comparisons);
}

int main(void)
{
    walk_proof_models();
    /* Observation uses the SAME walk, but cannot create A/D writes, proof
     * rows, ports, reservations or counters. Only resident fragments exist. */
    for(pl_u32 mode=0u;mode<4u;++mode){vm_mmu_context cpu=context();cpu.cpl=3u;reset(base);
        const char path[]="/run/service/s6rc-fdholder";pl_u64 address=base+4087u;
        for(pl_u32 n=0u;n<sizeof path;++n){pl_u32 at=4087u+n;arena[at<4096u?pages[4].offset+at:pages[5].offset+at-4096u]=(pl_u8)path[n];}
        if(mode==1u)pages[5].rights=0u;
        if(mode==2u)cpu.cr4|=1ull<<21u;
        if(mode==3u)put(entries[3],0u);
        vm_memory before=memory;memcpy(saved,arena,sizeof arena);pl_u8 observed[64]={0};
        int size=vm_mmu_observe_string(&memory,&cpu,address,observed);
        EXPECT(mode?size==-1:size==(int)sizeof path);
        if(!mode)EXPECT(!memcmp(observed,path,sizeof path));
        EXPECT(!memcmp(&before,&memory,sizeof memory));EXPECT(!memcmp(saved,arena,sizeof arena));
        EXPECT(vm_mmu_observe_string(&memory,&cpu,address,arena+1024u)==-1);
        EXPECT(!memcmp(saved,arena,sizeof arena));
    }
    /* Read-only 128-bit operands have the same complete preflight, without
     * the aligned RMW pair's write rights or retained reservation. */
    for (pl_u32 mode=0u;mode<8u;++mode) {
        vm_mmu_context cpu=context();reset(base);
        pl_u8 record[16];memset(record,0xa5,sizeof record);
        pl_u64 address=base+(mode==0u?1u:mode>=2u && mode<=4u?4088u:0u);
        pl_u32 flags=1u|(mode==0u || mode==5u || mode==6u?VM_MMU_ALIGNED16:0u);
        if(mode<2u)put(entries[3],0u);
        if(mode==2u)put(entries[3]+8u,0u);
        if(mode==3u)pages[5].kind=VM_MEMORY_DEFERRED;
        if(mode==5u)put(entries[3],0x8005u);
        if(mode==7u)put(port,8u);
        for(pl_u32 i=0u;i<8192u;++i)arena[28672u+i]=(pl_u8)(i*37u);
        memcpy(saved,arena,sizeof arena);
        machine_result result=vm_mmu_read_record(&memory,port,&cpu,address,mode==6u?8u:16u,flags,record);
        if(mode==0u)expect_fault(result,address,13u,0u);
        else if(mode==1u)expect_fault(result,address,14u,0u);
        else if(mode==2u)expect_fault(result,base+4096u,14u,0u);
        else if(mode==3u)EXPECT(result==MACHINE_RESULT_BARRIER);
        else if(mode==6u)EXPECT(result==MACHINE_RESULT_ENTRY_MAP);
        else if(mode==7u)EXPECT(result==MACHINE_RESULT_STALE_GENERATION);
        else {EXPECT(!result);EXPECT(!memcmp(record,arena+28672u+(pl_u32)(address-base),16u));}
        if(result)for(pl_u32 i=0u;i<16u;++i)EXPECT(record[i]==0xa5u);
        EXPECT(!memory.reservation.parts && !memcmp(saved+28672u,arena+28672u,8192u));
        if(mode==0u || mode==6u || mode==7u)EXPECT(!memcmp(saved+8192u,arena+8192u,16384u));
    }
    /* Every possible crossing split derives the same two words without a
     * temporary payload. Poisoned outputs survive a late fault/wait. */
    for(pl_u32 bytes=1u;bytes<=16u;++bytes)for (pl_u32 split=0u;split<bytes;++split)for(pl_u32 mode=0u;mode<4u;++mode) {
        vm_mmu_context cpu=context();reset(base);
        pl_u64 address=base+4096u-split;
        for(pl_u32 i=0u;i<8192u;++i)arena[28672u+i]=(pl_u8)(i*91u+split);
        put(port+8u,0x198abf6523e78621ull);put(port+48u,0x814fe24657319856ull);
        if(mode==1u)put(entries[3]+8u,0u);
        if(mode==2u)pages[5].kind=VM_MEMORY_DEFERRED;
        if(mode==3u)put(port,8u);
        memcpy(saved,arena,sizeof arena);
        machine_result result=vm_mmu_read_pair(&memory,port,&cpu,address,bytes,1u);
        if(mode==1u)expect_fault(result,base+4096u,14u,0u);
        else if(mode==2u)EXPECT(result==MACHINE_RESULT_BARRIER);
        else if(mode==3u)EXPECT(result==MACHINE_RESULT_STALE_GENERATION);
        else {
            EXPECT(!result);pl_u64 low=0u,high=0u;
            for(pl_u32 i=0u;i<bytes;++i) {
                if(i<8u)low|=(pl_u64)arena[32768u-split+i]<<(i*8u);
                else high|=(pl_u64)arena[32768u-split+i]<<((i-8u)*8u);
            }
            EXPECT(get(port+8u)==low && get(port+48u)==high);
        }
        if(result)EXPECT(get(port+8u)==0x198abf6523e78621ull && get(port+48u)==0x814fe24657319856ull);
        EXPECT(!memory.reservation.parts && !memcmp(saved+28672u,arena+28672u,8192u));
    }
    /* A wide record is one reservation, not two visible scalar transfers.
     * Misalignment wins over absent/readonly pages, before a walk sets A/D.
     * A failed reserve leaves the private sixteen-byte output unchanged. */
    for (pl_u32 mode=0u;mode<8u;++mode) {
        vm_mmu_context pair_cpu=context(); reset(base);
        pl_u8 record[16],original[16]; memset(record,0xa5,sizeof record); memcpy(original,record,sizeof record);
        pl_u64 address=base+(mode<3u ? 1u : mode==3u ? 4088u : 0u);
        if (mode==1u || mode==3u) put(entries[3],0u);
        if (mode==2u) put(entries[3],0x8005u);
        if (mode==4u) pages[4].kind=VM_MEMORY_DEFERRED;
        if (mode==5u) put(port,8u);
        if (mode==6u) pair_cpu.cr4|=1ull<<12u;
        memcpy(saved,arena,sizeof arena);
        machine_result pair=vm_mmu_reserve_record_access(&memory,port,&pair_cpu,address,16u,
            MACHINE_MEMORY_READ|MACHINE_MEMORY_WRITE|VM_MMU_ALIGNED16,record);
        if (mode<4u) {
            expect_fault(pair,address,13u,0u);
            memcpy(saved+port+16u,arena+port+16u,16u);
            EXPECT(!memcmp(saved,arena,sizeof arena));
        } else if (mode==4u) EXPECT(pair==MACHINE_RESULT_BARRIER);
        else if (mode==5u) EXPECT(pair==MACHINE_RESULT_STALE_GENERATION);
        else if (mode==6u) EXPECT(pair==MACHINE_RESULT_ENTRY_MAP);
        else {
            EXPECT(!pair && memory.reservation.parts==1u && memory.reservation.lengths[0]==16u);
            memset(record,0x7e,sizeof record);
            EXPECT(!vm_memory_commit_record(&memory,port,record,16u));
            EXPECT(!memcmp(arena+28672u,record,16u));
            EXPECT(vm_memory_commit_record(&memory,port,original,16u)==MACHINE_RESULT_ENTRY_MAP);
        }
        if (mode<7u) {
            EXPECT(!memcmp(record,original,sizeof record));
            EXPECT(!memory.reservation.parts);
            EXPECT(vm_memory_commit_record(&memory,port,record,16u)==(mode==5u ? MACHINE_RESULT_STALE_GENERATION : MACHINE_RESULT_ENTRY_MAP));
        }
    }
    for (pl_u32 stack=0u;stack<2u;++stack) {
        vm_mmu_context pair_cpu=context(); reset(base); pl_u8 record[16]; memset(record,0xa5,sizeof record);
        pl_u64 address=0x800000000000ull;
        expect_fault(vm_mmu_reserve_record_access(&memory,port,&pair_cpu,address,16u,
            3u|VM_MMU_ALIGNED16|(stack ? MACHINE_MEMORY_STACK : 0u),record),address,stack ? 12u : 13u,0u);
        for (pl_u32 i=0u;i<16u;++i) EXPECT(record[i]==0xa5u);
    }
    /* General private records may cross pages; only the aligned public pair
     * import forbids that geometry. No first fragment may become visible if
     * the second page faults or waits; successful commit consumes both once. */
    for (pl_u32 mode=0u;mode<3u;++mode) {
        vm_mmu_context pair_cpu=context(); reset(base); pl_u8 record[16]; memset(record,0xa5,sizeof record);
        if (!mode) put(entries[3]+8u,0u);
        if (mode==1u) pages[5].kind=VM_MEMORY_DEFERRED;
        machine_result pair=vm_mmu_reserve_record_access(&memory,port,&pair_cpu,base+4088u,16u,7u,record);
        if (!mode) expect_fault(pair,base+4096u,14u,2u);
        else if (mode==1u) EXPECT(pair==MACHINE_RESULT_BARRIER);
        else {
            EXPECT(!pair && memory.reservation.parts==2u);
            memset(record,0x7e,sizeof record); EXPECT(!vm_memory_commit_record(&memory,port,record,16u));
            EXPECT(!memcmp(arena+28672u+4088u,record,8u) && !memcmp(arena+32768u,record+8u,8u));
        }
        if (mode<2u) { for (pl_u32 i=0u;i<16u;++i) EXPECT(record[i]==0xa5u); EXPECT(!memory.reservation.parts); }
    }
    /* An executable linear page is not a physical RAM offset. Borrow the
     * C-translated, non-identity page; never mutate output on a rejected view. */
    vm_mmu_context code_cpu = context(); reset(base);
    vm_code_page code = {0}, saved_code;
    EXPECT(vm_mmu_code_page(&memory,port,&code_cpu,base + 17u,&code) == 0u);
    EXPECT(code.address == base && code.generation == 9u
           && code.offset == 28672u && code.bytes == 4096u);
    for (pl_u32 i = 0u; i < 4u; ++i) EXPECT(get(entries[i]) & 32u);
    EXPECT(!(get(entries[3]) & 64u)); /* Fetch never sets Dirty. */
    saved_code = code;
    put(entries[3],get(entries[3]) | (1ull << 63u));
    expect_fault(vm_mmu_code_page(&memory,port,&code_cpu,base + 17u,&code),base + 17u,14u,17u);
    EXPECT(memcmp(&code,&saved_code,sizeof code) == 0);
    reset(base); pages[4].kind = VM_MEMORY_DEFERRED;
    EXPECT(vm_mmu_code_page(&memory,port,&code_cpu,base + 17u,&code) == MACHINE_RESULT_BARRIER);
    EXPECT(get(port + 32u) == 0x8011u && get(port + 40u) == ((pl_u64)17u << 32u | 1u));
    EXPECT(memcmp(&code,&saved_code,sizeof code) == 0);
    reset(base); put(port,8u);
    EXPECT(vm_mmu_code_page(&memory,port,&code_cpu,base,&code) == MACHINE_RESULT_STALE_GENERATION);
    EXPECT(memcmp(&code,&saved_code,sizeof code) == 0);
    EXPECT(vm_mmu_code_page(&memory,port,&code_cpu,base,NULL) == MACHINE_RESULT_ENTRY_MAP);
    reset(base); put(entries[2],0x200083u); pages[5].address = 0x200000u;
    EXPECT(vm_memory_open(&memory,arena,sizeof arena,4096u,pages,6u,6u,branches,9u) == 0);
    EXPECT(vm_mmu_code_page(&memory,port,&code_cpu,base + 29u,&code) == 0u);
    EXPECT(code.offset == 32768u && code.address == base && code.bytes == 4096u);

    vm_mmu_context cpu = context(); reset(base);
    EXPECT(access(&cpu, base + 4093u, 8u, 2u, 0x8877665544332211ull) == 0u);
    EXPECT(arena[28672u + 4093u] == 0x11u && arena[32768u] == 0x44u);
    EXPECT(access(&cpu, base + 4093u, 8u, 1u, 0u) == 0u);
    EXPECT(get(port + 8u) == 0x8877665544332211ull);
    for (pl_u32 i = 0u; i < 4u; ++i) EXPECT(get(entries[i]) & 32u);
    EXPECT((get(entries[3]) & 96u) == 96u && (get(entries[3] + 8u) & 96u) == 96u);

    reset(base); put(entries[3] + 8u, 0u); memset(arena + 28672u, 0xa5, 8192u);
    memcpy(saved, arena, sizeof arena);
    expect_fault(access(&cpu, base + 4093u, 8u, 2u, 0u), base + 4096u, 14u, 2u);
    EXPECT(memcmp(saved + 28672u, arena + 28672u, 8192u) == 0);
    EXPECT(get(entries[0]) & 32u); /* Ancestor A is an architectural side effect. */
    EXPECT(get(port + 8u) == 0u);

    /* A write-intent read must preflight both pages and preserve the exact
     * physical destinations across the pure calculation, without rewalking. */
    reset(base); cpu = context();
    EXPECT(access(&cpu, base + 4093u, 8u, 2u, 0x8877665544332211ull) == 0u);
    EXPECT(vm_mmu_reserve(&memory, port, &cpu, base + 4093u, 8u, 3u) == 0u);
    EXPECT(get(port + 8u) == 0x8877665544332211ull);
    EXPECT(vm_memory_commit(&memory, port, 0x123456789abcdef0ull) == 0u);
    EXPECT(access(&cpu, base + 4093u, 8u, 1u, 0u) == 0u);
    EXPECT(get(port + 8u) == 0x123456789abcdef0ull);
    EXPECT(vm_memory_commit(&memory, port, 0u) == MACHINE_RESULT_ENTRY_MAP);

    reset(base); EXPECT(vm_mmu_reserve(&memory, port, &cpu, base, 8u, 3u) == 0u);
    put(port + 64u,9u);
    EXPECT(vm_memory_commit(&memory,port + 64u,0u) == MACHINE_RESULT_ENTRY_MAP);
    EXPECT(vm_memory_commit(&memory,port,0u) == MACHINE_RESULT_ENTRY_MAP);
    EXPECT(vm_mmu_reserve(&memory,port,&cpu,base,8u,3u) == 0u);
    vm_memory_abort(&memory);
    EXPECT(vm_memory_commit(&memory,port,0u) == MACHINE_RESULT_ENTRY_MAP);
    /* The RMW target can itself be a paging structure. A second translation
     * after the store would observe a different machine, not this instruction. */
    reset(base); put(entries[3],0x4067u);
    EXPECT(vm_mmu_reserve(&memory,port,&cpu,base,8u,3u) == 0u);
    EXPECT(get(port + 8u) == 0x4067u);
    EXPECT(vm_memory_commit(&memory,port,0u) == 0u);
    EXPECT(get(entries[3]) == 0u);
    reset(base); put(entries[3] + 8u, 0u); memset(arena + 28672u, 0xa5, 8192u);
    memcpy(saved, arena, sizeof arena);
    expect_fault(vm_mmu_reserve(&memory, port, &cpu, base + 4093u, 8u, 3u), base + 4096u, 14u, 2u);
    EXPECT(memcmp(saved + 28672u, arena + 28672u, 8192u) == 0);
    EXPECT(vm_memory_commit(&memory, port, 0u) == MACHINE_RESULT_ENTRY_MAP);
    reset(base); put(entries[3], 0x8005u);
    expect_fault(vm_mmu_reserve(&memory, port, &cpu, base, 8u, 3u), base, 14u, 3u);
    reset(base); pages[4].rights = 2u; /* Both residency rights are required. */
    EXPECT(vm_mmu_reserve(&memory, port, &cpu, base, 8u, 3u) == MACHINE_RESULT_BARRIER);
    reset(base); EXPECT(vm_mmu_reserve(&memory, port, &cpu, base, 8u, 3u) == 0u);
    EXPECT(vm_memory_open(&memory, arena, sizeof arena, 4096u, pages, 6u, 6u, branches, 9u) == 0);
    EXPECT(vm_memory_commit(&memory, port, 0u) == MACHINE_RESULT_ENTRY_MAP);
    EXPECT(vm_mmu_reserve(&memory, port, &cpu, base, 8u, 3u) == 0u);
    put(port, 8u);
    EXPECT(vm_memory_commit(&memory, port, 0u) == MACHINE_RESULT_STALE_GENERATION);
    put(port, 9u);
    EXPECT(vm_memory_commit(&memory, port, 0u) == MACHINE_RESULT_ENTRY_MAP);
    EXPECT(vm_mmu_reserve(&memory, port, &cpu, base, 8u, 3u) == 0u);
    EXPECT(access(&cpu, base, 8u, 1u, 0u) == 0u);
    EXPECT(vm_memory_commit(&memory, port, 0u) == MACHINE_RESULT_ENTRY_MAP);

    reset(base); pages[1].kind = VM_MEMORY_DEFERRED;
    EXPECT(access(&cpu, base, 8u, 1u, 0u) == MACHINE_RESULT_BARRIER);
    EXPECT(get(port + 32u) == 0x2000u);
    EXPECT(get(port + 40u) == ((pl_u64)17u << 32u | 8u));
    EXPECT(get(port + 24u) == 0u); /* A host miss does not manufacture #PF. */
    reset(base); pages[0].rights = 1u;
    EXPECT(access(&cpu, base, 8u, 1u, 0u) == MACHINE_RESULT_BARRIER);
    EXPECT(get(port + 40u) == ((pl_u64)18u << 32u | 8u));
    EXPECT(!(get(entries[0]) & 32u));
    reset(base); pages[4].kind = VM_MEMORY_DEFERRED;
    EXPECT(access(&cpu, base + 7u, 4u, 1u, 0u) == MACHINE_RESULT_BARRIER);
    EXPECT(get(port + 32u) == 0x8007u && get(port + 40u) == ((pl_u64)17u << 32u | 4u));

    reset(base); put(entries[0], get(entries[0]) | (1ull << 40u));
    expect_fault(access(&cpu, base, 8u, 1u, 0u), base, 14u, 9u);
    reset(base); put(entries[1], get(entries[1]) | 128u);
    expect_fault(access(&cpu, base, 8u, 1u, 0u), base, 14u, 9u); /* Unexposed 1 GiB. */
    reset(base); cpu.efer &= ~(1ull << 11u); put(entries[3], get(entries[3]) | (1ull << 63u));
    expect_fault(access(&cpu, base, 8u, 9u, 0u), base, 14u, 9u);
    reset(base); put(entries[0], 1ull << 40u);
    expect_fault(access(&cpu, base, 8u, 1u, 0u), base, 14u, 0u); /* Not-present first. */

    cpu = context(); reset(base); put(entries[2], 0x200083u); pages[5].address = 0x200000u;
    EXPECT(vm_memory_open(&memory, arena, sizeof arena, 4096u, pages, 6u, 6u, branches, 9u) == 0);
    EXPECT(access(&cpu, base + 256u, 8u, 2u, 0x1234u) == 0u);
    EXPECT(get(32768u + 256u) == 0x1234u && (get(entries[2]) & 96u) == 96u);
    put(entries[2], 0x202083u);
    expect_fault(access(&cpu, base, 8u, 1u, 0u), base, 14u, 9u);
    reset(base); cpu = context();
    expect_fault(access(&cpu, 0x800000000000ull, 8u, 1u, 0u), 0x800000000000ull, 13u, 0u);
    expect_fault(access(&cpu, ~0ull, 2u, 5u, 0u), ~0ull, 12u, 0u);
    cpu.cr4 |= 1ull << 12u;
    EXPECT(access(&cpu, base, 8u, 1u, 0u) == MACHINE_RESULT_ENTRY_MAP);
    cpu = context(); cpu.efer &= ~0x100ull; memcpy(saved, arena, sizeof arena);
    EXPECT(access(&cpu, base, 8u, 1u, 0u) == MACHINE_RESULT_ENTRY_MAP);
    EXPECT(memcmp(saved, arena, sizeof arena) == 0);
    cpu = context(); cpu.cr4 |= 128u; put(entries[3], get(entries[3]) | 256u);
    EXPECT(access(&cpu, base, 8u, 1u, 0u) == 0u); /* PGE/global, no cached TLB. */
    /* No large-page or global translation may survive a table mutation.
     * INVLPG has an empty target set only while every access/fetch rewalks.
     * Resident physical owners are retained; they are not TLB entries. */
    for (pl_u32 pge=0u;pge<2u;++pge)
    for (pl_u32 global=0u;global<2u;++global) {
        reset(base); cpu=context(); cpu.cr4|=(pl_u64)pge<<7u;
        pages[5].address=0x208000u;
        EXPECT(vm_memory_open(&memory,arena,sizeof arena,4096u,pages,6u,6u,branches,9u)==0);
        put(28672u,0x1111u); put(32768u,0x2222u);
        for (pl_u32 iteration=0u;iteration<64u;++iteration) {
            pl_u64 leaf=(iteration&1u ? 0x200000u : 0u)|0x83u|((pl_u64)global<<8u);
            put(entries[2],leaf);
            EXPECT(access(&cpu,base+0x8000u,8u,1u,0u)==0u);
            EXPECT(get(port+8u)==(iteration&1u ? 0x2222u : 0x1111u));
            EXPECT((get(entries[2])&96u)==32u);
            EXPECT(vm_mmu_code_page(&memory,port,&cpu,base+0x8000u,&code)==0u);
            EXPECT(code.offset==(iteration&1u ? 32768u : 28672u));
            EXPECT(access(&cpu,base+0x8008u,8u,2u,iteration)==0u);
            EXPECT((get(entries[2])&96u)==96u);
            put(entries[2],leaf&~2ull);
            expect_fault(access(&cpu,base+0x8008u,8u,2u,0u),base+0x8008u,14u,3u);
            put(entries[2],leaf|(1ull<<63u));
            expect_fault(vm_mmu_code_page(&memory,port,&cpu,base+0x8000u,&code),base+0x8000u,14u,17u);
            put(entries[2],0u);
            expect_fault(access(&cpu,base+0x8000u,8u,1u,0u),base+0x8000u,14u,0u);
        }
    }
    cpu = context(); put(port, 8u); memcpy(saved, arena, sizeof arena);
    EXPECT(access(&cpu, base, 8u, 2u, 0u) == MACHINE_RESULT_STALE_GENERATION);
    EXPECT(memcmp(saved, arena, sizeof arena) == 0);
    reset(0xffff800000400000ull);
    EXPECT(access(&cpu, 0xffff800000400000ull, 8u, 2u, 0x1234u) == 0u);
    EXPECT(get(28672u) == 0x1234u);

    /* Ten-byte architectural records commit CPU state only after complete
     * MMU admission. Null/noncanonical source, privilege and misses are not
     * successful table loads. Loaded bases need not be canonical themselves. */
    for (pl_u32 offset = 4085u; offset <= 4095u; ++offset)
        for (pl_u32 rank = 0u; rank < 2u; ++rank) {
            reset(base); cpu = context();
            machine_state state = {0}, before;
            vm_table_frontier frontier={0};
            state.cr0 = cpu.cr0; state.cr3 = cpu.cr3; state.cr4 = cpu.cr4;
            state.efer = cpu.efer; state.rflags = 2u; state.rip = 0x1234u;
            state.system[MACHINE_SYSTEM_CS] = 16u;
            state.system[MACHINE_SYSTEM_GDTR_BASE] = 0x9876u;
            for (pl_u32 i = 0u; i < 10u; ++i) arena[28672u + offset + i] = (pl_u8)(i + 1u);
            before = state;
            EXPECT(vm_table_transfer(&memory,port,&state,&frontier,base + offset,rank,1u) == 0u);
            pl_u32 at = rank ? MACHINE_SYSTEM_IDTR_BASE : MACHINE_SYSTEM_GDTR_BASE;
            before.system[at] = 0x0a09080706050403ull; before.system[at + 1u] = 0x0201u;
            EXPECT(memcmp(&state,&before,sizeof state) == 0);
            state = before; state.system[MACHINE_SYSTEM_CS] = 19u; before = state;
            put(entries[3],0u);
            expect_fault(vm_table_transfer(&memory,port,&state,&frontier,~0ull,rank,1u),state.rip,13u,0u);
            EXPECT(memcmp(&state,&before,sizeof state) == 0);
            state.system[MACHINE_SYSTEM_CS] = 16u; before = state;
            expect_fault(vm_table_transfer(&memory,port,&state,&frontier,base + offset,rank,1u),base + offset,14u,0u);
            EXPECT(memcmp(&state,&before,sizeof state) == 0);
            put(entries[3],0x8067u); put(entries[3] + 8u,0u);
            if (offset >= 4087u) {
                expect_fault(vm_table_transfer(&memory,port,&state,&frontier,base + offset,rank,1u),base + 4096u,14u,0u);
                EXPECT(memcmp(&state,&before,sizeof state) == 0);
            }
        }

    /* Far return: stack/descriptor checks and hidden CS commit. These outer
     * inputs have no valid saved SS; report #GP instead of refusing the family. */
    pl_u32 returns = 0u;
    for (pl_u32 cpl = 0u; cpl < 4u; ++cpl)
    for (pl_u32 rpl = 0u; rpl < 4u; ++rpl)
    for (pl_u32 access_byte = 0u; access_byte < 256u; ++access_byte) {
        reset(base); cpu = context();
        machine_state state = {0}, before;
        machine_segments segments = {0}, old_segments;
        segments.version = MACHINE_SEGMENTS_ABI_VERSION;
        segments.cache[MACHINE_SEGMENT_CS].attributes = 0xa09bu;
        state.cr0 = cpu.cr0; state.cr3 = cpu.cr3; state.cr4 = cpu.cr4; state.efer = cpu.efer;
        state.rflags = 2u; state.rip = base + 32u;
        state.system[MACHINE_SYSTEM_CS] = 8u | cpl;
        state.system[MACHINE_SYSTEM_GDTR_BASE] = base;
        state.system[MACHINE_SYSTEM_GDTR_LIMIT] = 31u;
        state.registers[4] = base + 4093u;
        pl_u64 descriptor = 0x00af00000000ffffull | ((pl_u64)access_byte << 40u);
        put(28672u + 16u,descriptor);
        pl_u64 frame[2] = {base + 256u,0xffffffffffff0010ull | rpl};
        memcpy(arena + 28672u + 4093u,frame,sizeof frame);
        before = state; old_segments = segments;
        machine_result result = vm_far_return(&memory,port,&state,&segments,7u);
        pl_u32 dpl = (access_byte >> 5u) & 3u, vector = 0u;
        int denied = (access_byte & 24u) != 24u || rpl < cpl
            || (access_byte & 4u ? dpl > rpl : dpl != rpl);
        if (denied) vector = 13u; else if (!(access_byte & 128u)) vector = 11u;
        if (vector) expect_fault(result,before.rip,vector,16u);
        else if (rpl != cpl) expect_fault(result,before.rip,13u,0u);
        else {
            EXPECT(result == 0u);
            before.system[MACHINE_SYSTEM_CS] = 16u | rpl;
            before.rip = base + 256u; before.registers[4] += 23u;
            old_segments.cache[MACHINE_SEGMENT_CS] = (machine_segment_cache){0u,0xffffffffu,
                0xa000u | access_byte | 1u};
            EXPECT((arena[28672u + 21u] & 1u) != 0u);
        }
        EXPECT(memcmp(&state,&before,sizeof state) == 0);
        EXPECT(memcmp(&segments,&old_segments,sizeof segments) == 0);
        ++returns;
    }
    reset(base); cpu = context();
    machine_state returning = {0}, before_return;
    machine_segments return_segments = {0}, before_segments;
    return_segments.version = MACHINE_SEGMENTS_ABI_VERSION;
    return_segments.cache[MACHINE_SEGMENT_CS].attributes = 0xa09bu;
    returning.cr0 = cpu.cr0; returning.cr3 = cpu.cr3; returning.cr4 = cpu.cr4;
    returning.efer = cpu.efer; returning.rflags = 2u; returning.rip = base + 64u;
    returning.system[MACHINE_SYSTEM_CS] = 16u; returning.system[MACHINE_SYSTEM_GDTR_BASE] = base;
    returning.system[MACHINE_SYSTEM_GDTR_LIMIT] = 31u; returning.registers[4] = base + 4093u;
    put(28672u + 16u,0x00af9a000000ffffull);
    pl_u64 frame[2] = {0x800000000000ull,16u};
    memcpy(arena + 28672u + 4093u,frame,sizeof frame);
    before_return = returning; before_segments = return_segments;
    expect_fault(vm_far_return(&memory,port,&returning,&return_segments,0u),returning.rip,13u,0u);
    EXPECT(!(arena[28672u + 21u] & 1u));
    put(entries[3] + 8u,0u);
    expect_fault(vm_far_return(&memory,port,&returning,&return_segments,0u),base + 4096u,14u,0u);
    EXPECT(memcmp(&returning,&before_return,sizeof returning) == 0);
    EXPECT(memcmp(&return_segments,&before_segments,sizeof return_segments) == 0);
    put(entries[3] + 8u,0x9067u);
    frame[0] = base + 256u; memcpy(arena + 28672u + 4093u,frame,sizeof frame);
    /* The implicit descriptor Accessed store can fault after a valid stack
     * read. No target/cache/RSP update may escape that precise boundary. */
    put(entries[3],0x8065u);
    expect_fault(vm_far_return(&memory,port,&returning,&return_segments,0u),base + 21u,14u,3u);
    EXPECT(!(arena[28672u + 21u] & 1u));
    EXPECT(memcmp(&returning,&before_return,sizeof returning) == 0);
    EXPECT(memcmp(&return_segments,&before_segments,sizeof return_segments) == 0);
    put(entries[3],0x8067u); put(28672u + 16u,0x00ef9b000000ffffull); /* Invalid L=DB=1. */
    expect_fault(vm_far_return(&memory,port,&returning,&return_segments,0u),returning.rip,13u,16u);
    EXPECT(memcmp(&returning,&before_return,sizeof returning) == 0);
    EXPECT(memcmp(&return_segments,&before_segments,sizeof return_segments) == 0);
    put(28672u + 16u,0x00cf9b000000ffffull); /* Valid compatibility target, not admitted. */
    EXPECT(vm_far_return(&memory,port,&returning,&return_segments,0u) == MACHINE_RESULT_ENTRY_MAP);
    EXPECT(memcmp(&returning,&before_return,sizeof returning) == 0);
    EXPECT(memcmp(&return_segments,&before_segments,sizeof return_segments) == 0);
    printf("Far-return descriptor/privilege model: %u cases; not hardware exception entry\n",returns);

    /* Exhaustive permissions meet over all four levels, both privilege
     * classes, supervisor WP settings and read/write/execute directions. */
    pl_u32 comparisons = 0u;
    for (pl_u32 pattern = 0u; pattern < 4096u; ++pattern)
        for (pl_u32 direction = 0u; direction < 3u; ++direction)
            for (pl_u32 mode = 0u; mode < 4u; ++mode) {
                reset(base); cpu = context();
                cpu.cpl = mode & 1u ? 3u : 0u;
                if (!(mode & 2u)) cpu.cr0 &= ~0x10000ull;
                int all_user = 1, all_write = 1, any_nx = 0;
                for (pl_u32 level = 0u; level < 4u; ++level) {
                    pl_u32 bits = (pattern >> (level * 3u)) & 7u;
                    pl_u64 entry = get(entries[level]) & ~6ull;
                    if (bits & 1u) entry |= 4u; else all_user = 0;
                    if (bits & 2u) entry |= 2u; else all_write = 0;
                    if (bits & 4u) { entry |= 1ull << 63u; any_nx = 1; }
                    put(entries[level], entry);
                }
                pl_u32 flags = direction == 0u ? 1u : direction == 1u ? 2u : 9u;
                int denied = (cpu.cpl == 3u && !all_user)
                           || (direction == 1u && !all_write && (cpu.cpl == 3u || (mode & 2u)))
                           || (direction == 2u && any_nx);
                machine_result result = access(&cpu, base, 8u, flags, 0x1234u);
                if (denied) expect_fault(result, base, 14u,
                    1u | (direction == 1u ? 2u : 0u) | (cpu.cpl == 3u ? 4u : 0u)
                       | (direction == 2u ? 16u : 0u));
                else EXPECT(result == 0u);
                ++comparisons;
            }
    if (!failures) printf("four-level MMU: green (%u permission cases; no CPU fault delivery/boot oracle)\n", comparisons);
    return failures ? 1 : 0;
}
