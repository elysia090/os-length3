.section .text
.globl _start
.type _start, @function
_start:
    .rept 32
    nop
    .endr
    xor %edi, %edi
    call probe
    test %eax, %eax
    jne failed
    mov $8, %edi
    call probe
    cmp $4, %eax
    jne failed
    mov $42, %edi
    jmp finished
failed:
    mov $1, %edi
finished:
    mov $60, %eax
    syscall
    ud2
.size _start, .-_start
.type probe, @function
probe:
    /* BSF/BSR consume the previous destination when their source is zero.
     * The following addition implements a zero-safe one-based bit index. */
#if defined(SCAN_WORD)
    mov $0xffff, %ebp
#if defined(SCAN_REVERSE)
    bsr %di, %bp
#else
    bsf %di, %bp
#endif
    add $1, %bp
#elif defined(SCAN_QUAD)
    mov $-1, %rbp
#if defined(SCAN_REVERSE)
    bsr %rdi, %rbp
#else
    bsf %rdi, %rbp
#endif
    add $1, %rbp
#else
    mov $-1, %ebp
#if defined(SCAN_REVERSE)
    bsr %edi, %ebp
#else
    bsf %edi, %ebp
#endif
    add $1, %ebp
#endif
    mov %ebp, %eax
    ret
.size probe, .-probe
.section .text.unreachable,"ax",@progbits
.fill 16384, 1, 0xcc
.section .note.GNU-stack,"",@progbits
