/* The guard and the table index read the same structure field through a
 * copied pointer. A write to the copied pointer invalidates that equality. */
.section .text
.globl _start
.type _start, @function
_start:
    leaq .Lstate(%rip), %rdi
    movq %rdi, %r10
    cmpl $49, 0xac(%rdi)
    ja .Lbad
#ifdef BREAK_COPY
    addq $4, %r10
#endif
    movl 0xac(%r10), %eax
    leaq .Ltable(%rip), %rdx
    movslq (%rdx,%rax,4), %rax
    addq %rdx, %rax
    jmp *%rax
.Lcase1:
    movl $42, %edi
    jmp .Lexit
.Lbad:
    movl $1, %edi
.Lexit:
    movl $60, %eax
    syscall
.size _start, .-_start

.section .rodata
.p2align 2
.Ltable:
    .long .Lbad - .Ltable
    .long .Lcase1 - .Ltable
    .rept 48
    .long .Lbad - .Ltable
    .endr

.section .data
.p2align 3
.Lstate:
    .zero 0xac
    .long 1

.section .note.GNU-stack,"",@progbits
.section .debug_fixture,"",@progbits
.rept 4096
.byte 0
.endr
