/* Sequential bounds intersect; a genuine bypass retains the wider bound.
 * The rejected path loops through an earlier table before the second table. */
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
.Lhead:
    movl %edi, %eax
    cmpl $99, %eax
    ja .LguardB
#ifdef ALTERNATIVE_PATH
    testl %esi, %esi
    jne .LafterTight
#else
    cmpl $12, %eax
    ja .Ldefault
#endif
    cmpl $14, %eax
    ja .Ldefault
.LafterTight:
    leaq .LtableA(%rip), %rcx
    movzbl %al, %edx
    movslq (%rcx,%rdx,4), %rdx
    addq %rcx, %rdx
    jmp *%rdx
.Ldefault:
    addl $1, %edi
    cmpl $130, %edi
    ja .Lreturn
    jmp .Lhead
.LguardB:
    leal -100(%rax), %edx
    cmpl $27, %edx
    ja .Ldefault
    leaq .LtableB(%rip), %rcx
    movzbl %dl, %edx
    movslq (%rcx,%rdx,4), %rdx
    addq %rcx, %rdx
    jmp *%rdx
.Lcase:
    movl $42, %eax
    ret
.Lreturn:
    movl $43, %eax
    ret
.size .Ldispatch, .-.Ldispatch

.section .rodata
.p2align 2
.LtableA:
#ifdef ALTERNATIVE_PATH
    .rept 100
#else
    .rept 15
#endif
    .long .Lcase - .LtableA
    .endr
.LtableB:
    .rept 28
    .long .Lcase - .LtableB
    .endr

.section .note.GNU-stack,"",@progbits
.section .debug_fixture,"",@progbits
.rept 4096
.byte 0
.endr
