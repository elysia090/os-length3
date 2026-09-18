#include <x86/profile.h>

static int has(pl_u32 word, pl_u32 bit)
{
    return (word & (1u << bit)) != 0u;
}

int main(void)
{
    pl_x86_cpuid_result leaf1 = pl_x86_profile_cpuid(1u, 0u);
    const pl_u32 required_ecx[] = { 0u, 9u, 13u, 19u, 20u, 23u };
    const pl_u32 required_edx[] = { 0u, 8u, 15u, 23u, 24u, 25u, 26u };
    for (pl_u32 i = 0u;
         i < sizeof(required_ecx) / sizeof(required_ecx[0]); ++i)
        if (!has(leaf1.ecx, required_ecx[i])) return 1;
    for (pl_u32 i = 0u;
         i < sizeof(required_edx) / sizeof(required_edx[0]); ++i)
        if (!has(leaf1.edx, required_edx[i])) return 2;

    if (has(leaf1.ecx, 26u) || has(leaf1.ecx, 27u)
            || has(leaf1.ecx, 28u) || has(leaf1.ecx, 30u))
        return 3;
    pl_x86_cpuid_result extended =
        pl_x86_profile_cpuid(0x80000001u, 0u);
    if (!has(extended.ecx, 0u) || !has(extended.edx, 11u)
            || !has(extended.edx, 20u) || !has(extended.edx, 29u))
        return 4;
    pl_x86_cpuid_result xsave = pl_x86_profile_cpuid(0xdu, 0u);
    if (xsave.eax || xsave.ebx || xsave.ecx || xsave.edx
            || PL_X86_XCR0_VISIBLE || PL_X86_XSAVE_BYTES)
        return 5;
    if (PL_X86_AUXV_HWCAP != leaf1.edx || PL_X86_AUXV_HWCAP2 != 0u)
        return 6;
    pl_x86_cpuid_result unknown = pl_x86_profile_cpuid(0x12345678u, 9u);
    if (unknown.eax || unknown.ebx || unknown.ecx || unknown.edx)
        return 7;
    return 0;
}
