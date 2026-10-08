#include <stdio.h>
#include <stdint.h>
#ifdef _WIN32
#include <windows.h>
static uint8_t *page,*entry;static volatile unsigned events,bad;
static uint64_t flags;static unsigned length;
static LONG CALLBACK observe(EXCEPTION_POINTERS *exception)
{
    __asm__ volatile("cld":::"cc");
    if(exception->ExceptionRecord->ExceptionCode!=EXCEPTION_SINGLE_STEP)return EXCEPTION_CONTINUE_SEARCH;
    ++events;CONTEXT *cpu=exception->ContextRecord;
    if(cpu->Rip!=(uintptr_t)entry+length||(cpu->EFlags&0x10000u)
        ||(cpu->EFlags&0xcd5u)!=(flags&0xcd5u))++bad;
    cpu->Rip=(uintptr_t)page;return EXCEPTION_CONTINUE_EXECUTION;
}
#endif
int main(void)
{
#ifndef _WIN32
    return 2;
#else
    page=VirtualAlloc(NULL,8192u,MEM_COMMIT|MEM_RESERVE,PAGE_READWRITE);if(!page)return 1;
    DWORD old;if(!VirtualProtect(page+4096u,4096u,PAGE_NOACCESS,&old)){VirtualFree(page,0u,MEM_RELEASE);return 1;}
    PVOID handler=AddVectoredExceptionHandler(1u,observe);if(!handler){VirtualFree(page,0u,MEM_RELEASE);return 1;}
    const uint8_t prefixes[]={0u,0x66u,0x67u,0x48u,0x64u,0x65u,0xf2u,0xf3u};int failed=1;
    for(unsigned form=0u;form<8u;++form){
        if(!VirtualProtect(page,4096u,PAGE_READWRITE,&old))goto done;
        page[0]=0xc3u;length=form?2u:1u;entry=page+4096u-length;
        if(form)entry[0]=prefixes[form];
        entry[length-1u]=0xf1u;
        if(!VirtualProtect(page,4096u,PAGE_EXECUTE_READ,&old)||!FlushInstructionCache(GetCurrentProcess(),page,4096u))goto done;
        for(unsigned row=0u;row<64u;++row){flags=0x202u|((row*73u)&0x8d5u)|((row&1u)?0x400u:0u);
            __asm__ volatile("pushq %[flags]; popfq; call *%[code]; cld"::[flags]"r"(flags),[code]"r"(entry):"memory","cc");}
    }
    failed=bad||events!=512u;
    printf("{\"format\":\"native-int1-page-end-v1\",\"status\":\"%s\",\"forms\":8,\"nativeUserTraps\":%u,\"mismatches\":%u,\"successorPageAccessible\":false,\"oracle\":\"physical Windows CPL3 saved RIP/RFLAGS; no raw DR or privileged-frame certificate\",\"linuxBoot\":\"not-tested\"}\n",failed?"invalid":"observed",events,bad);
done:if(!RemoveVectoredExceptionHandler(handler)||!VirtualFree(page,0u,MEM_RELEASE))failed=1;return failed;
#endif
}
