#ifndef SELECTOR_RANK
#define SELECTOR_RANK 2
#endif
.intel_syntax noprefix
.text
.global _start
.type _start,@function
_start:
#if defined(SELECTOR_MEMORY)
#if SELECTOR_ADDRESS == 32
    .byte 0x67
#endif
#if SELECTOR_PREFIX == 1
    .byte 0x66
#elif SELECTOR_PREFIX == 2
    .byte 0x48
#endif
#if SELECTOR_CASE == 1
    .byte 0x8c,0x45 | (SELECTOR_RANK << 3),0x00 /* SS:[rbp] */
#elif SELECTOR_CASE == 2
    .byte 0x8c,0x44 | (SELECTOR_RANK << 3),0x8f,0x07 /* [rdi+rcx*4+7] */
#elif SELECTOR_CASE == 3
    .byte 0x8c,0x05 | (SELECTOR_RANK << 3),8,0,0,0 /* [rip+8] */
#else
    .byte 0x8c,0x07 | (SELECTOR_RANK << 3) /* [rdi] */
#endif
#else
#if SELECTOR_WIDTH == 16
    .byte 0x66
#endif
#if SELECTOR_WIDTH == 64
    .byte 0x48 | SELECTOR_EXTENDED
#elif SELECTOR_EXTENDED
    .byte 0x41
#endif
    .byte 0x8c,0xc0 | (SELECTOR_RANK << 3) | SELECTOR_EXTENDED
#endif
    /* The ordinary optimized ELF retains this observer boundary. Only its
     * private oracle mapping replaces the following byte with RET. */
    pushfq
    pop r11
    ret
.size _start,.-_start
.rept 4096
    nop
.endr
.section .note.GNU-stack,"",@progbits
