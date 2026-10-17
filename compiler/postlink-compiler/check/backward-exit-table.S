/* A bounded table's failure arm may return through an earlier code address.
 * That arm is safe only while it cannot re-enter the load without the guard. */
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
.Ldefault_return:
#ifdef BREAK_EXIT
    jmp .Lload
#else
    movl $1, %eax
    ret
#endif
.Lguard:
    movl %edi, %ebx
    subl $1, %ebx
    cmpl $31, %ebx
    ja .Ldefault_return
    leaq .Ltable(%rip), %r12
.Lload:
    movslq (%r12,%rbx,4), %rax
    addq %r12, %rax
    jmp *%rax
.Lcase0:
    movl $42, %eax
    ret
.size .Ldispatch, .-.Ldispatch

.section .rodata
.p2align 2
.Ltable:
    .long .Lcase0 - .Ltable
    .rept 31
    .long .Ldefault_return - .Ltable
    .endr

.section .note.GNU-stack,"",@progbits
.section .debug_fixture,"",@progbits
.rept 4096
.byte 0
.endr
