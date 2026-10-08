#include <vm/control.h>
#include <machine/control.h>
#include "memory-internal.h"
#include "segments-internal.h"
#include <stddef.h>
static int canonical(pl_u64 address)
{return address>>47u==0u||address>>47u==0x1ffffu;}
static machine_result fault(pl_u8 *port,const machine_state *state,pl_u32 vector,pl_u32 error)
{
    vm_memory_store(port+offsetof(machine_memory_port,fault_address),state->rip,8u);
    vm_memory_store(port+offsetof(machine_memory_port,fault_vector),vector,4u);
    vm_memory_store(port+offsetof(machine_memory_port,fault_error),error,4u);
    return machine_result_make(MACHINE_RESULT_FAULT,vector);
}
static machine_result stack_word(vm_memory *memory,pl_u32 port,const vm_mmu_context *context,
    pl_u64 address,pl_u32 bytes,pl_u64 *value)
{
    machine_result result=vm_mmu_access(memory,port,context,address,bytes,MACHINE_MEMORY_READ|MACHINE_MEMORY_STACK,0u);
    if(!result)*value=vm_memory_load(memory->bytes+port+offsetof(machine_memory_port,value),bytes);
    return result;
}
machine_result vm_far_return(vm_memory *memory,pl_u32 port_offset,machine_state *state,machine_segments *segments,pl_u32 word)
{
    vm_memory_abort(memory);pl_u32 bytes=machine_return_bytes(word),discard=word&MACHINE_RETURN_DISCARD_MASK;
    if(!bytes||!memory||!memory->bytes||!memory->generation||!state||!segments||(port_offset&7u)
        ||(pl_u64)port_offset+sizeof(machine_memory_port)>memory->reserved_bytes
        ||segments->version!=MACHINE_SEGMENTS_ABI_VERSION||segments->interrupt_shadow>MACHINE_SHADOW_STI
        ||!(segments->cache[MACHINE_SEGMENT_CS].attributes&0x2000u)
        ||(segments->cache[MACHINE_SEGMENT_CS].attributes&(0x4000u|MACHINE_SEGMENT_UNUSABLE))
        ||(state->rflags&0x60100u)||(state->cr4&(1ull<<23u)))return MACHINE_RESULT_ENTRY_MAP;
    pl_u8 *port=memory->bytes+port_offset;
    if(vm_memory_load(port,8u)!=memory->generation)return MACHINE_RESULT_STALE_GENERATION;
    pl_u32 cpl=(pl_u32)state->system[MACHINE_SYSTEM_CS]&3u;
    vm_mmu_context context={state->cr0,state->cr3,state->cr4,state->efer,cpl};
    pl_u64 sp=state->registers[4],target,selector_word;
    if(sp>~0ull-(2u*bytes-1u))return fault(port,state,12u,0u);
    machine_result result=stack_word(memory,port_offset,&context,sp,bytes,&target);if(result)return result;
    result=stack_word(memory,port_offset,&context,sp+bytes,2u,&selector_word);if(result)return result;
    pl_u32 selector=(pl_u32)selector_word,error=selector&0xfffcu,rpl=selector&3u;
    pl_u64 code_address,descriptor;
    result=vm_descriptor_read(memory,port_offset,state,segments,selector,0u,&code_address,&descriptor);if(result)return result;
    machine_segment_cache code=vm_segment_cache_decode(descriptor);
    pl_u32 access=(pl_u32)(descriptor>>40u)&255u,dpl=(access>>5u)&3u;
    if((access&0x18u)!=0x18u||(code.attributes&0x6000u)==0x6000u||rpl<cpl
        ||(access&4u?dpl>rpl:dpl!=rpl))return fault(port,state,13u,error);
    if(!(access&128u))return fault(port,state,11u,error);
    if(!(code.attributes&0x2000u))return MACHINE_RESULT_ENTRY_MAP;
    pl_u64 next_sp=sp+2u*bytes+discard;
    pl_u32 ss=0u,stack_access=1u;pl_u64 stack_address=0u;machine_segment_cache stack={0};
    if(rpl>cpl){
        result=vm_descriptor_accessed(memory,port_offset,state,code_address,access);if(result)return result;
        if(sp>~0ull-(4u*bytes+discard-1u))return fault(port,state,12u,0u);
        pl_u64 outer=sp+2u*bytes+discard,ss_word;
        result=stack_word(memory,port_offset,&context,outer+bytes,2u,&ss_word);if(result)return result;
        ss=(pl_u32)ss_word;
        if((ss&3u)!=rpl)return fault(port,state,13u,ss&0xfffcu);
        stack=(machine_segment_cache){0u,0u,MACHINE_SEGMENT_UNUSABLE|(rpl<<5u)};
        if(ss&0xfffcu){
            result=vm_descriptor_read(memory,port_offset,state,segments,ss,0u,&stack_address,&descriptor);if(result)return result;
            stack_access=(pl_u32)(descriptor>>40u)&255u;
            if((stack_access&0x1au)!=0x12u||((stack_access>>5u)&3u)!=rpl)return fault(port,state,13u,ss&0xfffcu);
            if(!(stack_access&128u))return fault(port,state,12u,ss&0xfffcu);
            stack=vm_segment_cache_decode(descriptor);
        }else if(rpl==3u)return fault(port,state,13u,0u);
        result=stack_word(memory,port_offset,&context,outer,bytes,&next_sp);if(result)return result;
        result=vm_descriptor_accessed(memory,port_offset,state,stack_address,stack_access);if(result)return result;
        next_sp+=discard;
    }
    if(!canonical(target))return fault(port,state,13u,0u);
    if(rpl==cpl){result=vm_descriptor_accessed(memory,port_offset,state,code_address,access);if(result)return result;}
    state->system[MACHINE_SYSTEM_CS]=selector;segments->cache[MACHINE_SEGMENT_CS]=code;
    if(rpl>cpl){state->system[MACHINE_SYSTEM_SS]=ss;segments->cache[MACHINE_SEGMENT_SS]=stack;vm_segments_outer(state,segments,rpl);}
    state->registers[4]=next_sp;state->rip=target;return 0u;
}
