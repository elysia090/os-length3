/* Exact virtual CPU identity shared by admission, native execution and Wasm.
 *
 * "x86-64-v2" is only the user-facing level name.  These words are the
 * normative contract.  Every unlisted CPUID leaf and every unlisted bit is
 * zero, so host discovery can never silently widen the accepted ISA.
 */

#ifndef X86_PROFILE_H
#define X86_PROFILE_H

#include <support/types.h>

#define PL_X86_PROFILE_ID             "development-standard-v1"
#define PL_X86_PROFILE_LEVEL          "x86-64-v2"

#define PL_X86_CPUID_MAX_BASIC        7u
#define PL_X86_CPUID_VENDOR_EBX       0x756e6547u
#define PL_X86_CPUID_VENDOR_ECX       0x6c65746eu
#define PL_X86_CPUID_VENDOR_EDX       0x49656e69u
#define PL_X86_CPUID_SIGNATURE        0x000306a9u

/* CPUID.1:ECX: SSE3, SSSE3, CX16, SSE4.1, SSE4.2 and POPCNT. */
#define PL_X86_CPUID_1_ECX            ((1u << 0u)  | (1u << 9u)  \
                                     | (1u << 13u) | (1u << 19u) \
                                     | (1u << 20u) | (1u << 23u))

/* CPUID.1:EDX: the psABI baseline plus PSE, TSC and MSR for the machine. */
#define PL_X86_CPUID_1_EDX            ((1u << 0u)  | (1u << 3u)  \
                                     | (1u << 4u)  | (1u << 5u)  \
                                     | (1u << 8u)  | (1u << 15u) \
                                     | (1u << 23u) | (1u << 24u) \
                                     | (1u << 25u) | (1u << 26u))

#define PL_X86_CPUID_7_0_EBX          0u
#define PL_X86_CPUID_7_0_ECX          0u
#define PL_X86_CPUID_7_0_EDX          0u
#define PL_X86_CPUID_MAX_EXTENDED     0x80000008u
#define PL_X86_CPUID_80000001_ECX     (1u << 0u) /* LAHF/SAHF */
#define PL_X86_CPUID_80000001_EDX     ((1u << 11u) | (1u << 20u) \
                                     | (1u << 29u))
#define PL_X86_CPUID_80000008_EAX     ((48u << 8u) | 40u)

/* v2 has no XSAVE/OSXSAVE requirement.  This profile deliberately exposes
 * neither: CPUID.0d is zero, XGETBV/XSETBV are #UD, and no XCR0 component is
 * part of the public machine state.  x87/SSE state uses the FXSAVE layout. */
#define PL_X86_XCR0_VISIBLE           0ull
#define PL_X86_XSAVE_BYTES            0u
#define PL_X86_CR4_OSFXSR_REQUIRED    (1u << 9u)
#define PL_X86_CR4_OSXSAVE_VISIBLE    0u

/* CPU-derived auxv values.  Address-, credential- and image-derived entries
 * remain per-exec bindings and are not a second CPU feature channel. */
#define PL_X86_AUXV_HWCAP             PL_X86_CPUID_1_EDX
#define PL_X86_AUXV_HWCAP2            0u
#define PL_X86_AUXV_PAGESZ            4096u
#define PL_X86_AUXV_CLKTCK            100u
#define PL_X86_AUXV_PLATFORM          "x86_64"

typedef struct {
    pl_u32 eax;
    pl_u32 ebx;
    pl_u32 ecx;
    pl_u32 edx;
} pl_x86_cpuid_result;

static inline pl_x86_cpuid_result
pl_x86_profile_cpuid(pl_u32 leaf, pl_u32 subleaf)
{
    pl_x86_cpuid_result result = { 0u, 0u, 0u, 0u };
    if (leaf == 0u) {
        result.eax = PL_X86_CPUID_MAX_BASIC;
        result.ebx = PL_X86_CPUID_VENDOR_EBX;
        result.ecx = PL_X86_CPUID_VENDOR_ECX;
        result.edx = PL_X86_CPUID_VENDOR_EDX;
    } else if (leaf == 1u) {
        result.eax = PL_X86_CPUID_SIGNATURE;
        result.ecx = PL_X86_CPUID_1_ECX;
        result.edx = PL_X86_CPUID_1_EDX;
    } else if (leaf == 7u && subleaf == 0u) {
        result.ebx = PL_X86_CPUID_7_0_EBX;
        result.ecx = PL_X86_CPUID_7_0_ECX;
        result.edx = PL_X86_CPUID_7_0_EDX;
    } else if (leaf == 0x80000000u) {
        result.eax = PL_X86_CPUID_MAX_EXTENDED;
    } else if (leaf == 0x80000001u) {
        result.ecx = PL_X86_CPUID_80000001_ECX;
        result.edx = PL_X86_CPUID_80000001_EDX;
    } else if (leaf == 0x80000008u) {
        result.eax = PL_X86_CPUID_80000008_EAX;
    }
    return result;
}

#endif /* X86_PROFILE_H */
