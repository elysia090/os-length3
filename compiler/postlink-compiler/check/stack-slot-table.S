/* The table index is copied through an RSP-relative red-zone slot.  Its
 * finite bound belongs to r9d, not the r15 register used by the load. A
 * case loops back through the guard, and dead alignment bytes precede it. */
.section .text
.globl _start
.type _start, @function
_start:
    movl (%rsp), %r9d
    leaq .Ltable(%rip), %r14
.Lretry:
    movl %r9d, %edx
    movq %rdx, -16(%rsp)
    cmpl $6, %r9d
    ja .Lbad
#ifdef BREAK_SLOT
    pushq %rax
    popq %rax
#endif
    movq -16(%rsp), %r15
    movslq (%r14,%r15,4), %r13
    addq %r14, %r13
    jmp *%r13
.Lcase0:
    movl $10, %edi
    jmp .Lexit
.p2align 4, 0x90
.Lcase1:
    xorl %r9d, %r9d
    jmp .Lretry
.Lbad:
    movl $1, %edi
.Lexit:
    movl $60, %eax
    syscall
.size _start, .-_start

.section .rodata
.p2align 2
.Ltable:
    .long .Lcase0 - .Ltable
    .long .Lcase1 - .Ltable
    .rept 5
    .long .Lbad - .Ltable
    .endr

.section .note.GNU-stack,"",@progbits

/* The fixture includes ordinary non-load construction data so the product
 * size gate measures the removal of that data as well as runtime parity. */
.section .debug_fixture,"",@progbits
.rept 4096
.byte 0
.endr
