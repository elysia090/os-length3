#ifndef POSTLINK_CPU_H
#define POSTLINK_CPU_H

/* One immutable CPU identity is consumed by both the post-link compiler and
 * vm.wasm.  Feature-dependent decodes belong to this identity: an extension
 * that the published CPUID does not expose has the single architectural #UD
 * residual, rather than an unbounded family of unused vector states. */
#define PL_X86_CPUID_MAX_BASIC       7u
#define PL_X86_CPUID_VENDOR_EBX      0x756e6547u
#define PL_X86_CPUID_VENDOR_ECX      0x6c65746eu
#define PL_X86_CPUID_VENDOR_EDX      0x49656e69u
#define PL_X86_CPUID_SIGNATURE       0x000306a9u
#define PL_X86_CPUID_1_ECX           (1u << 30u)
#define PL_X86_CPUID_1_EDX           0x07008139u
#define PL_X86_CPUID_7_0_EBX         (1u << 18u)
#define PL_X86_CPUID_7_0_ECX         0u
#define PL_X86_CPUID_7_0_EDX         0u
#define PL_X86_CPUID_MAX_EXTENDED    0x80000008u
#define PL_X86_CPUID_80000001_ECX    1u
#define PL_X86_CPUID_80000001_EDX    ((1u << 11u) | (1u << 20u) \
                                      | (1u << 29u))
#define PL_X86_CPUID_80000008_EAX    ((48u << 8u) | 40u)

#endif
