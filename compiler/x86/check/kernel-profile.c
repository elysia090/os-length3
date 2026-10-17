/* Hardware feature words consumed by the Linux compressed-kernel CPU check.
 * Pass masks from that kernel's generated asm/cpufeaturemasks.h. Linux's
 * synthesized feature words are deliberately not treated as CPUID leaves. */
#include <x86/profile.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>

int main(int argc, char **argv)
{
    const pl_u32 leaves[] = { 1u, 0x80000001u, 1u, 0x80000001u, 7u };
    const pl_u32 words[] = { 0u, 1u, 4u, 6u, 16u };
    /* Exact hardware masks from the shipped 7.2.7 kernel configuration. */
    pl_u32 required[] = { 0x0700a169u, 0x20000000u, 0u, 0u, 0u };
    if (argc != 1 && argc != 6) return 2;
    if (argc == 6) for (unsigned i = 0u; i < 5u; ++i) {
        char *end = NULL;
        errno = 0;
        unsigned long value = strtoul(argv[i + 1u], &end, 16);
        if (errno || end == argv[i + 1u] || *end || value > 0xfffffffful) return 2;
        required[i] = (pl_u32)value;
    }
    int failures = 0;
    for (unsigned i = 0u; i < 5u; ++i) {
        pl_x86_cpuid_result cpuid = pl_x86_profile_cpuid(leaves[i], 0u);
        pl_u32 actual = i < 2u ? cpuid.edx : cpuid.ecx;
        pl_u32 missing = required[i] & ~actual;
        printf("kernel CPU word=%u required=%08x actual=%08x missing=%08x\n",
               words[i], required[i], actual, missing);
        if (missing) ++failures;
    }
    return failures ? 1 : 0;
}
