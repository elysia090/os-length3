.text
.globl _start
.type _start,@function
_start:
#if SUMMARY_WIDTH == 16
#define DEST %ax
#define SOURCE %di
#define EXT_DEST %r9w
#define EXT_SOURCE %r8w
#elif SUMMARY_WIDTH == 32
#define DEST %eax
#define SOURCE %edi
#define EXT_DEST %r9d
#define EXT_SOURCE %r8d
#else
#define DEST %rax
#define SOURCE %rdi
#define EXT_DEST %r9
#define EXT_SOURCE %r8
#endif
#if SUMMARY_KIND == 2 || SUMMARY_KIND == 3
    .byte 0xf3 /* Legacy scan under the fixed CPU's absent count extension. */
#endif
#if SUMMARY_KIND == 0 || SUMMARY_KIND == 2
#define OP bsf
#elif SUMMARY_KIND == 1 || SUMMARY_KIND == 3
#define OP bsr
#else
#define OP popcnt
#endif
#if SUMMARY_CASE == 1
    OP DEST,DEST
#elif SUMMARY_CASE == 2
    OP EXT_SOURCE,EXT_DEST
    /* Keep the extended result live across post-link optimization. The
     * observer limits this cut to the scan, before this ABI-visible copy. */
    mov %r9,%rax
#else
    OP SOURCE,DEST
#if SUMMARY_CASE >= 3
    sete %dl
#if SUMMARY_CASE == 4
    xor %r8d,%r8d /* ZF consumer must survive this later flag kill. */
#endif
    mov $0,%eax /* Undefined scan destination cannot leak into this oracle. */
#endif
#endif
    ret
.size _start,.-_start
.section .note.GNU-stack,"",@progbits
