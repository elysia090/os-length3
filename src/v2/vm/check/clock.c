#include <vm/clock.h>
#include <stdio.h>
#include <string.h>
static _Alignas(8) pl_u8 arena[4096];
static unsigned failures, observations;
#define EXPECT(x) do { ++observations; if (!(x)) { if (failures < 8u) fprintf(stderr,"clock: line %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static void put(pl_u32 at, pl_u64 value)
{ for (pl_u32 byte=0u;byte<8u;++byte) arena[at+byte]=(pl_u8)(value>>(byte*8u)); }
int main(void)
{
    _Static_assert(sizeof(vm_clock)==88u,"one clock frontier, no boundary snapshot");
    vm_clock clock={0}; vm_memory memory={0}; machine_state state={0};
    static const pl_u64 generations[]={1u,9u,1ull<<63u,~0ull};
    for (pl_u32 row=0u;row<4u;++row) {
        pl_u64 issued=clock.issued; vm_clock_close(&clock); EXPECT(clock.issued==issued);
        memory.bytes=arena; memory.reserved_bytes=sizeof arena; memory.generation=generations[row];
        state.rip=0x400000u; state.retired=123u; put(0u,memory.generation); put(64u,memory.generation);
        for(pl_u32 cycle=0u;cycle<256u;++cycle){
            machine_state cpu=state; pl_u32 port=cycle&1u?64u:0u;
            EXPECT(vm_clock_boundary_sample(&clock,&memory,port,&state)==18u);
            pl_u64 ticket=clock.ticket;
            EXPECT(ticket==++issued && clock.stage==1u && clock.key==VM_CLOCK_BOUNDARY_KEY);
            vm_clock pending=clock;
            EXPECT(vm_clock_boundary_sample(&clock,&memory,port,&state)==18u && !memcmp(&clock,&pending,sizeof clock));
            EXPECT(vm_clock_sample(&clock,&memory,port,&state,0x100000000ull,0u)==6u);
            EXPECT(!memcmp(&clock,&pending,sizeof clock));
            EXPECT(vm_clock_reply(&clock,memory.generation^1u,port,&state,ticket,cycle)==-1);
            EXPECT(vm_clock_reply(&clock,memory.generation,port^64u,&state,ticket,cycle)==-1);
            EXPECT(vm_clock_reply(&clock,memory.generation,port,&state,ticket+1u,cycle)==-1);
            ++state.rip; EXPECT(vm_clock_reply(&clock,memory.generation,port,&state,ticket,cycle)==-1); --state.rip;
            EXPECT(!memcmp(&clock,&pending,sizeof clock));
            if(cycle>1u)EXPECT(vm_clock_reply(&clock,memory.generation,port,&state,ticket,cycle-2u)==-1);
            EXPECT(!vm_clock_reply(&clock,memory.generation,port,&state,ticket,cycle));
            EXPECT(!vm_clock_reply(&clock,memory.generation,port,&state,ticket,cycle));
            EXPECT(vm_clock_reply(&clock,memory.generation,port,&state,ticket,cycle+1u)==-1);
            EXPECT(!vm_clock_boundary_sample(&clock,&memory,port,&state) && !clock.stage);
            EXPECT(!vm_clock_reply(&clock,memory.generation,port,&state,ticket,cycle));
            EXPECT(vm_clock_reply(&clock,memory.generation,port^64u,&state,ticket,cycle)==-1);
            EXPECT(!memcmp(&cpu,&state,sizeof state)); ++state.rip;
        }
    }
    pl_u64 acknowledged=clock.ticket;
    EXPECT(!vm_clock_reply(&clock,memory.generation,clock.port,&state,acknowledged,255u));
    vm_clock_abort(&clock);
    EXPECT(vm_clock_reply(&clock,memory.generation,clock.port,&state,acknowledged,255u)==-1);
    EXPECT(clock.now==255u && clock.issued==acknowledged);
    vm_clock_close(&clock); clock.issued=~0ull;
    EXPECT(vm_clock_boundary_sample(&clock,&memory,0u,&state)==6u && !clock.stage);
    clock.issued=0u; put(0u,0u);
    EXPECT(vm_clock_boundary_sample(&clock,&memory,0u,&state)==5u && !clock.stage);
    put(0u,memory.generation);
    EXPECT(vm_clock_boundary_sample(&clock,&memory,1u,&state)==6u);
    EXPECT(vm_clock_boundary_sample(&clock,&memory,4096u,&state)==6u);
    EXPECT(vm_clock_boundary_sample(NULL,&memory,0u,&state)==6u);
    EXPECT(vm_clock_boundary_sample(&clock,NULL,0u,&state)==6u);
    EXPECT(vm_clock_boundary_sample(&clock,&memory,0u,NULL)==6u);
    EXPECT(vm_clock_boundary_sample(&clock,&memory,0u,&state)==18u);
    pl_u64 cancelled=clock.ticket; vm_clock_abort(&clock);
    EXPECT(vm_clock_reply(&clock,memory.generation,0u,&state,cancelled,256u)==-1);
    EXPECT(vm_clock_boundary_sample(&clock,&memory,0u,&state)==18u && clock.ticket>cancelled);
    EXPECT(vm_clock_reply(&clock,memory.generation,0u,&state,cancelled,256u)==-1);
    if (!failures) printf("C clock: %u boundary/ticket/generation/duplicate/refusal observations green (not Linux boot)\n",observations);
    return failures?1:0;
}
