#ifndef POSTLINK_CHECK_EXECUTE_H
#define POSTLINK_CHECK_EXECUTE_H

#include <stddef.h>

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

static void *test_code_allocate(size_t bytes)
{
    return VirtualAlloc(NULL, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
}

static int test_code_publish(void *memory, size_t bytes)
{
    DWORD previous;
    return VirtualProtect(memory, bytes, PAGE_EXECUTE_READ, &previous)
        && FlushInstructionCache(GetCurrentProcess(), memory, bytes);
}

static void test_code_release(void *memory, size_t bytes)
{
    (void)bytes;
    if (memory) (void)VirtualFree(memory, 0u, MEM_RELEASE);
}
#else
#include <sys/mman.h>

static void *test_code_allocate(size_t bytes)
{
    void *memory = mmap(NULL, bytes, PROT_READ | PROT_WRITE,
                        MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    return memory == MAP_FAILED ? NULL : memory;
}

static int test_code_publish(void *memory, size_t bytes)
{
    return mprotect(memory, bytes, PROT_READ | PROT_EXEC) == 0;
}

static void test_code_release(void *memory, size_t bytes)
{
    if (memory) (void)munmap(memory, bytes);
}
#endif

#endif
