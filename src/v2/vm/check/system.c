/* Independent value-state model; hardware observations are a separate oracle. */
#include <vm/system.h>
#include <stdio.h>
#include <string.h>
static _Alignas(8) pl_u8 arena[8192];
static machine_state state;
static machine_segments segments;
static unsigned failures,cases,faults,refusals;
#define EXPECT(x) do { if(!(x)){fprintf(stderr,"system transfer: line %u\n",(unsigned)__LINE__);++failures;} } while(0)
static void put(pl_u32 at,pl_u64 value)
{for(pl_u32 i=0u;i<8u;++i)arena[at+i]=(pl_u8)(value>>(i*8u));}
static pl_u64 get(pl_u32 at)
{pl_u64 value=0u;for(pl_u32 i=0u;i<8u;++i)value|=(pl_u64)arena[at+i]<<(i*8u);return value;}
static void reset(pl_u32 cpl,pl_u64 star,pl_u64 mask)
{
    memset(arena,0xa5,sizeof arena);put(0u,9u);
    state=(machine_state){0};state.cr0=0x80010011u;state.cr3=0xdead000u;
    state.cr4=32u;state.efer=0x501u;state.rip=0x100230u;state.rflags=0x10647u;
    state.retired=123u;state.work=456u;state.span=78u;
    for(pl_u32 i=0u;i<16u;++i)state.registers[i]=(pl_u64)(i+1u)*0xabcdefff123ull;
    state.registers[1]=0x1002beu;state.registers[4]=0x800000000000ull;
    state.registers[11]=0x8000000000038647ull;
    state.system[MACHINE_SYSTEM_CS]=8u|cpl;state.system[MACHINE_SYSTEM_SS]=16u|cpl;
    state.msr_count=MACHINE_MSR_BANK_COUNT;
    for(pl_u32 i=0u;i<MACHINE_MSR_BANK_COUNT;++i){state.msr_keys[i]=machine_msr_rank_key(i);state.msr_values[i]=machine_msr_rank_reset(i);}
    state.msr_values[2]=star;state.msr_values[3]=0xffffffff81001000ull;state.msr_values[5]=mask;
    segments=(machine_segments){0};segments.version=MACHINE_SEGMENTS_ABI_VERSION;
    segments.interrupt_shadow=MACHINE_SHADOW_MOV_SS;
    for(pl_u32 i=0u;i<8u;++i)segments.cache[i]=(machine_segment_cache){(pl_u64)i*0x12345000u,123u+i,0xc093u};
    segments.cache[MACHINE_SEGMENT_CS].attributes=0xa09bu|(cpl<<5u);
}
static void model(vm_memory *memory,pl_u32 op,pl_u32 cpl,pl_u64 star,pl_u64 mask,int sce,int bad_rcx)
{
    reset(cpl,star,mask);if(!sce)state.efer&=~1ull;
    if(bad_rcx)state.registers[1]=0x800000000000ull;
    machine_state expected=state;machine_segments hidden=segments;
    pl_u8 ram[4096];memcpy(ram,arena+4096u,sizeof ram);
    pl_u32 vector=!sce?6u:(op && (cpl || bad_rcx))?13u:0u;
    if(!vector){
        if(op){expected.rip=state.registers[1];expected.rflags=(state.registers[11]&0x3c7fd7u)|2u;
            expected.system[MACHINE_SYSTEM_CS]=(((star>>48u)+16u)&65535u)|3u;
            expected.system[MACHINE_SYSTEM_SS]=(((star>>48u)+8u)&65535u)|3u;
        }else{expected.rip=state.msr_values[3];expected.rflags=((state.rflags&~0x10000ull)&~mask)|2u;
            expected.registers[1]=state.rip+2u;expected.registers[11]=state.rflags&~0x10000ull;
            expected.system[MACHINE_SYSTEM_CS]=(star>>32u)&65532u;
            expected.system[MACHINE_SYSTEM_SS]=((star>>32u)+8u)&65535u;
        }
        hidden.cache[MACHINE_SEGMENT_CS]=(machine_segment_cache){0u,0xffffffffu,op?0xa0fbu:0xa09bu};
        hidden.cache[MACHINE_SEGMENT_SS]=(machine_segment_cache){0u,0xffffffffu,op?0xc0f3u:0xc093u};
        hidden.interrupt_shadow=0u;
    }
    memory->reservation.generation=9u;memory->reservation.parts=1u;
    EXPECT(vm_system_transfer(memory,0u,&state,&segments,op,op?0u:state.rip+2u)
        ==(vector?machine_result_make(MACHINE_RESULT_FAULT,vector):0u));
    EXPECT(!memcmp(&expected,&state,sizeof state));EXPECT(!memcmp(&hidden,&segments,sizeof hidden));
    EXPECT(!memcmp(ram,arena+4096u,sizeof ram));EXPECT(!memory->reservation.generation);
    if(vector){EXPECT(get(16u)==state.rip && get(24u)==vector);++faults;}
    ++cases;
}
int main(void)
{
    vm_memory memory;vm_memory_page page={0x1000u,4096u,3u,VM_MEMORY_RAM,0u,0u};
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,&page,1u,1u,NULL,9u));
    const pl_u64 selectors[]={0u,8u,9u,10u,11u,64u,0xfff8u,0xffffu};
    const pl_u64 masks[]={0u,2u,0x600u,0xffffffffu};
    for(pl_u32 op=0u;op<2u;++op)for(pl_u32 cpl=0u;cpl<4u;++cpl)
    for(pl_u32 sel=0u;sel<8u;++sel)for(pl_u32 mask=0u;mask<4u;++mask)
    for(int sce=0;sce<2;++sce)for(int bad=0;bad<2;++bad)
        model(&memory,op,cpl,(selectors[sel]<<32u)|(selectors[7u-sel]<<48u),masks[mask],sce,bad);
    /* Every absent bank suffix has its declared reset action; no lazy write. */
    for(pl_u32 count=0u;count<=6u;++count){reset(3u,0u,0u);state.msr_count=count;
        EXPECT(!vm_system_transfer(&memory,0u,&state,&segments,0u,state.rip+2u));
        EXPECT(state.msr_count==count && state.rip==(count>3u?0xffffffff81001000ull:0u));}
    for(pl_u32 test=0u;test<16u;++test){
        reset(0u,0x0018000800000000ull,0u);pl_u32 op=0u,port=0u;pl_u64 next=state.rip+2u;
        switch(test){case 0:put(0u,8u);break;case 1:port=1u;break;case 2:port=4096u;break;
        case 3:op=2u;break;case 4:next=state.rip;break;case 5:next=state.rip+16u;break;
        case 6:op=1u;break;case 7:segments.version=1u;break;case 8:segments.interrupt_shadow=3u;break;
        case 9:state.rflags|=0x100u;break;case 10:state.cr4|=1ull<<23u;break;
        case 11:state.msr_keys[3]=0u;break;case 12:state.msr_values[3]=0x800000000000ull;break;
        case 13:segments.cache[MACHINE_SEGMENT_CS].attributes|=0x4000u;break;
        case 14:state.system[MACHINE_SYSTEM_CS]|=3u;break;
        default:segments.cache[MACHINE_SEGMENT_CS].attributes&=~8u;break;}
        machine_state expected=state;machine_segments hidden=segments;pl_u8 before[8192];memcpy(before,arena,sizeof arena);
        memory.reservation.generation=9u;memory.reservation.parts=1u;
        EXPECT(vm_system_transfer(&memory,port,&state,&segments,op,next)==(test?6u:5u));
        EXPECT(!memcmp(&expected,&state,sizeof state) && !memcmp(&hidden,&segments,sizeof hidden));
        EXPECT(!memcmp(before,arena,sizeof arena) && !memory.reservation.generation);++refusals;
    }
    EXPECT(vm_system_transfer(NULL,0u,&state,&segments,0u,0u)==6u);
    if(failures)return 1;
    printf("SYSCALL/SYSRET: %u whole-state models, %u precise faults, %u unchanged refusals; no stack/page access\n",cases,faults,refusals);return 0;
}
