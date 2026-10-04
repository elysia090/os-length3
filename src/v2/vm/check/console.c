#include <vm/console.h>
#include <stdio.h>
#include <string.h>
static _Alignas(8) pl_u8 bytes[4096];
static vm_memory physical;
static machine_state state;
static vm_console console;
static unsigned failures,cases;
#define EXPECT(x) do { if(!(x)){fprintf(stderr,"console: line %u\n",(unsigned)__LINE__);++failures;} } while(0)
static void reset(void)
{
    vm_console_close(&console);memset(bytes,0,sizeof bytes);bytes[0]=9u;bytes[48]=9u;
    physical=(vm_memory){0};physical.bytes=bytes;physical.reserved_bytes=4096u;physical.generation=9u;
    state=(machine_state){0};state.rip=0x400000u;state.retired=42u;
}
int main(void)
{
    for(pl_u32 byte=0u;byte<256u;++byte){
        reset();machine_state before=state;
        EXPECT(vm_console_write(&console,&physical,0u,&state,byte)==26u);
        pl_u64 ticket=console.ticket;vm_console pending=console;
        EXPECT(vm_console_write(&console,&physical,0u,&state,byte)==26u && console.ticket==ticket);
        EXPECT(vm_console_write(&console,&physical,0u,&state,byte^1u)==6u);
        EXPECT(vm_console_write(&console,&physical,48u,&state,byte)==6u);
        for(pl_u32 bad=0u;bad<5u;++bad){
            state.rip+=(bad==4u);
            EXPECT(vm_console_reply(&console,bad==0u ? 8u : 9u,bad==1u ? 8u : 0u,&state,
                ticket+(bad==2u),byte^(bad==3u))==-1);
            state.rip-=(bad==4u);EXPECT(!memcmp(&console,&pending,sizeof console));++cases;
        }
        EXPECT(vm_console_reply(&console,9u,0u,&state,ticket,byte)==1);
        EXPECT(vm_console_reply(&console,9u,0u,&state,ticket,byte)==0);
        EXPECT(!vm_console_write(&console,&physical,0u,&state,byte));
        EXPECT(!vm_console_consume(&console) && !vm_console_pending(&console));
        EXPECT(vm_console_consume(&console)==-1);state.rip++;
        EXPECT(vm_console_reply(&console,9u,0u,&state,ticket,byte)==0);state.rip--;
        EXPECT(!memcmp(&state,&before,sizeof state));
        EXPECT(vm_console_write(&console,&physical,0u,&state,byte)==26u && console.ticket>ticket);
        pending=console;EXPECT(vm_console_reply(&console,9u,0u,&state,ticket,byte)==-1);
        EXPECT(!memcmp(&console,&pending,sizeof console));
        vm_console_abort(&console);EXPECT(vm_console_reply(&console,9u,0u,&state,console.ticket,byte)==-1);
        EXPECT(vm_console_write(&console,&physical,0u,&state,byte)==26u && console.ticket>pending.ticket);
        ticket=console.ticket;vm_console_close(&console);
        EXPECT(vm_console_reply(&console,9u,0u,&state,ticket,byte)==-1);
        EXPECT(vm_console_write(&console,&physical,0u,&state,byte)==26u && console.ticket>ticket);++cases;
    }
    reset();console.issued=~0ull;vm_console before=console;
    EXPECT(vm_console_write(&console,&physical,0u,&state,0u)==6u && !memcmp(&console,&before,sizeof console));
    console.issued=0u;before=console;
    EXPECT(vm_console_write(&console,&physical,1u,&state,0u)==6u);
    EXPECT(vm_console_write(&console,&physical,4096u,&state,0u)==6u);
    EXPECT(vm_console_write(&console,&physical,0u,&state,256u)==6u);
    bytes[0]=8u;EXPECT(vm_console_write(&console,&physical,0u,&state,0u)==5u);
    EXPECT(!memcmp(&console,&before,sizeof console));
    if(!failures)printf("C console: %u byte/ticket/generation/duplicate/cancel cases green; no guest retirement or external persistence claim\n",cases);
    return failures ? 1 : 0;
}
