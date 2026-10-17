/* Both rejected arms traverse the same loop and can reach the other table.
 * Its 1,200-instruction tail also exceeds a 1,024-instruction walk limit. */
.section .text
.globl _start
.type _start, @function
_start:
    xorl %edi, %edi
    xorl %esi, %esi
    call choose
    cmpl $41, %eax
    jne .Lbad
    movl $1, %edi
    call choose
    cmpl $42, %eax
    jne .Lbad
    movl $2, %edi
    movl $1, %esi
    call choose
    cmpl $43, %eax
    jne .Lbad
    movl $99, %edi
    xorl %esi, %esi
    call choose
    cmpl $41, %eax
    jne .Lbad
    movl $99, %edi
    movl $1, %esi
    call choose
    cmpl $41, %eax
    jne .Lbad
    xorl %edi, %edi
    jmp .Lexit
.Lbad:
    movl $90, %edi
.Lexit:
    movl $60, %eax
    syscall
.size _start, .-_start

.type choose, @function
choose:
.Lhead:
    testl %esi, %esi
    jne .LguardB
    cmpl $1, %edi
    ja .Lnext
.LdispatchA:
    leaq .LtableA(%rip), %rcx
    movslq (%rcx,%rdi,4), %rax
    addq %rcx, %rax
    jmp *%rax
.LguardB:
    cmpl $2, %edi
    ja .Lnext
    leaq .LtableB(%rip), %rcx
    movslq (%rcx,%rdi,4), %rax
    addq %rcx, %rax
    jmp *%rax
.Lnext:
    .rept 1200
    nop
    .endr
    xorl %edi, %edi
    jmp .Lhead
.L41:
    movl $41, %eax
    ret
.L42:
    movl $42, %eax
    ret
.L43:
    movl $43, %eax
    ret
.size choose, .-choose

.section .rodata
.p2align 2
.LtableA:
    .long .L41 - .LtableA
    .long .L42 - .LtableA
.LtableB:
    .long .L41 - .LtableB
    .long .L42 - .LtableB
#ifdef BYPASS_GUARD
    /* This row bypasses A's guard with index 2. Removing A must invalidate
     * B's proof too; a single validation pass would leave a false assumption. */
    .long .LdispatchA - .LtableB
#else
    .long .L43 - .LtableB
#endif

.section .note.GNU-stack,"",@progbits
.section .debug_fixture,"",@progbits
.rept 4096
.byte 0
.endr
