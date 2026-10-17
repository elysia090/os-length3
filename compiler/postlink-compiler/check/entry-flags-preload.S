/* A load preserves the caller's flags. SETcc must consume those flags before
 * a pending shift tree is materialized, not merely before its final AND. */
.section .text
.globl _start
.type _start, @function
_start:
#if ENTRY_FLAGS_CASE == 1
    movl $256, %ecx
#elif ENTRY_FLAGS_CASE == 2
    movl $0x80000000, %ecx
#else
    movl $4, %ecx
#endif
    movl $0x123400, %r9d
#if ENTRY_FLAGS_CASE == 3
    movl $0x567800, %r10d
#endif
    call choose
    movl %eax, %edi
    movl $60, %eax
    syscall
.size _start, .-_start

.type choose, @function
choose:
#if ENTRY_FLAGS_CASE == 2
    testl $0x80000087, %ecx
#else
    testl $0x87, %ecx
#endif
    movl %ecx, %r8d
    movq .Lpointer(%rip), %rax
#if ENTRY_FLAGS_CASE == 1
    sete %r9b
#elif ENTRY_FLAGS_CASE == 2
    setl %r9b
#else
    setne %r9b
#endif
#if ENTRY_FLAGS_CASE == 3
    sete %r10b
#endif
    shrl $8, %r8d
    andl $1, %r8d
    testb $2, (%rax)
    cmpl $0x123401, %r9d
    jne .Lbad
#if ENTRY_FLAGS_CASE == 3
    cmpl $0x567800, %r10d
    jne .Lbad
#endif
#if ENTRY_FLAGS_CASE == 1
    cmpl $1, %r8d
#else
    testl %r8d, %r8d
#endif
    jne .Lbad
    movl $42, %eax
    ret
.Lbad:
    movl $1, %eax
    ret
.size choose, .-choose

.section .rodata
.p2align 3
.Lpointer:
    .quad .Lbyte
.Lbyte:
    .byte 2
.section .note.GNU-stack,"",@progbits
.section .debug_fixture,"",@progbits
.rept 4096
.byte 0
.endr
