/* A rejected arm may revisit a guard through an already closed table.
 * Every row of that earlier table must be considered; one bypass rejects it. */
.section .text
.globl _start
.type _start, @function
_start:
    movl (%rsp), %edi
    call .Ldispatch
    movl %eax, %edi
    movl $60, %eax
    syscall
.size _start, .-_start

.type .Ldispatch, @function
.Ldispatch:
    leaq .LtableB(%rip), %r14
    leaq .LtableA(%rip), %r9
    movl %edi, %ebx
    subl $1, %ebx
    jmp .LguardA
.Lnext:
    addl $1, %ebx
.LguardA:
    cmpl $5, %ebx
    ja .Ldone
    movslq (%r9,%rbx,4), %rax
    addq %r9, %rax
    jmp *%rax
.LguardB:
    cmpl $5, %ebx
    ja .Lnext
.LloadB:
    movslq (%r14,%rbx,4), %rax
    addq %r14, %rax
    jmp *%rax
.LcaseB:
    movl $42, %eax
    ret
.Ldone:
    movl $43, %eax
    ret
.size .Ldispatch, .-.Ldispatch

.section .rodata
.p2align 2
.LtableA:
#ifdef BREAK_CUT
    .long .LguardB - .LtableA
    .long .LguardB - .LtableA
    .long .LguardB - .LtableA
    .long .LguardB - .LtableA
    .long .LguardB - .LtableA
    .long .LloadB - .LtableA
#else
    .rept 6
    .long .LguardB - .LtableA
    .endr
#endif
.LtableB:
    .rept 6
    .long .LcaseB - .LtableB
    .endr

.section .note.GNU-stack,"",@progbits
.section .debug_fixture,"",@progbits
.rept 4096
.byte 0
.endr
