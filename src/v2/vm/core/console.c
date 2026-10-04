#include <vm/console.h>
#include "memory-internal.h"
#include <stddef.h>
void vm_console_abort(vm_console *console)
{ if(console)console->stage=0u; }
void vm_console_close(vm_console *console)
{ if(console){pl_u64 issued=console->issued;*console=(vm_console){0};console->issued=issued;} }
int vm_console_pending(const vm_console *console)
{ return console && (console->stage==1u || console->stage==2u); }
machine_result vm_console_write(vm_console *console,vm_memory *physical,
    pl_u32 port,const machine_state *state,pl_u32 byte)
{
    if(!console || !physical || !physical->bytes || !physical->generation || !state || byte>255u
            || (port&7u) || (pl_u64)port+sizeof(machine_memory_port)>physical->reserved_bytes)
        return MACHINE_RESULT_ENTRY_MAP;
    pl_u8 *output=physical->bytes+port;
    if(vm_memory_load(output,8u)!=physical->generation)return MACHINE_RESULT_STALE_GENERATION;
    if(vm_console_pending(console)){
        if(console->generation!=physical->generation || console->port!=port
                || console->rip!=state->rip || console->byte!=byte)return MACHINE_RESULT_ENTRY_MAP;
        if(console->stage==2u)return 0u;
    }else{
        if(console->stage>3u || console->issued==~0ull)return MACHINE_RESULT_ENTRY_MAP;
        console->ticket=++console->issued;console->generation=physical->generation;
        console->rip=state->rip;console->port=port;console->byte=byte;console->stage=1u;
    }
    vm_memory_store(output+offsetof(machine_memory_port,value),byte,8u);
    vm_memory_store(output+offsetof(machine_memory_port,request_address),console->ticket,8u);
    vm_memory_store(output+offsetof(machine_memory_port,request_bytes),1u,4u);
    vm_memory_store(output+offsetof(machine_memory_port,request_access),MACHINE_CONSOLE_WRITE_REQUEST,4u);
    return machine_result_make(MACHINE_RESULT_BARRIER,MACHINE_BARRIER_CONSOLE);
}
int vm_console_reply(vm_console *console,pl_u64 generation,pl_u32 port,
    const machine_state *state,pl_u64 ticket,pl_u32 byte)
{
    if(!console || !state || !generation || !ticket || byte>255u || !console->stage
            || console->stage>3u || generation!=console->generation || port!=console->port
            || ticket!=console->ticket || byte!=console->byte)return -1;
    if(console->stage!=3u && state->rip!=console->rip)return -1;
    if(console->stage!=1u)return 0;
    console->stage=2u;return 1;
}
int vm_console_consume(vm_console *console)
{ if(!console || console->stage!=2u)return -1;console->stage=3u;return 0; }
