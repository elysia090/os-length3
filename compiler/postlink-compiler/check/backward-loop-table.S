/* The rejected arm of a finite table may loop, provided every path back to
 * the table crosses the same comparison. A bypass must not prove its rows. */
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
    jmp .Lguard
.Ldefault:
    addl $1, %edi
    cmpl $10, %edi
    ja .Lreturn
#ifdef BREAK_LOOP
    jmp .Lload
#else
    jmp .Lguard
#endif
.Lguard:
    movl %edi, %eax
    subl $1, %eax
    cmpl $8, %eax
    ja .Ldefault
    leaq .Ltable(%rip), %rcx
.Lload:
    movslq (%rcx,%rax,4), %rax
    addq %rcx, %rax
    jmp *%rax
.Lcase0:
    movl $42, %eax
    ret
.Lreturn:
    movl $43, %eax
    ret
.size .Ldispatch, .-.Ldispatch

.section .rodata
.p2align 2
.Ltable:
    .rept 9
    .long .Lcase0 - .Ltable
    .endr

.section .note.GNU-stack,"",@progbits
.section .debug_fixture,"",@progbits
.rept 4096
.byte 0
.endr
