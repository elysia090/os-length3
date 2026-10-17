.section .text
.globl _start
.type _start, @function
_start:
    .rept 32
    nop
    .endr
    lea state(%rip), %rdi
#if defined(CLEAR_EXTENDED)
    mov $0x300, %r8d
#else
    mov $0x300, %ecx
#endif
    call probe
    jnz failed
#if defined(CLEAR_WORD)
    movabs $0x1122334455660000, %rdx
    cmp %rdx, %rax
#else
    cmp $42, %rax
#endif
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
    /* A lane clear preserves the rest of the copied pointer. Dropping its
     * full-word producer turns the following load into an unrelated access. */
    mov 24(%rdi), %rdx
#if defined(CLEAR_EXTENDED)
    mov %rdx, %r8
#if defined(CLEAR_WORD)
    xor %r8w, %r8w
#else
    xor %r8b, %r8b
#endif
#if defined(CLEAR_WORD)
    mov %r8, %rax
#else
    mov (%r8), %rax
#endif
#else
    mov %rdx, %rcx
#if defined(CLEAR_WORD)
    xor %cx, %cx
#elif defined(CLEAR_AND)
    and $0, %cl
#else
    xor %cl, %cl
#endif
#if defined(CLEAR_WORD)
    mov %rcx, %rax
#else
    mov (%rcx), %rax
#endif
#endif
    ret
.size probe, .-probe
.section .data
.balign 256
value:
    .quad 42
state:
#if defined(CLEAR_WORD)
    .quad 0, 0, 0, 0x1122334455667788
#else
    .quad 0, 0, 0, value+27
#endif
.section .text.unreachable,"ax",@progbits
.fill 16384, 1, 0xcc
.section .note.GNU-stack,"",@progbits
