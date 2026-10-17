/* A rejected switch arm tail-calls a separately declared function. Its
 * straight-line body exceeds eight instructions but returns normally; the
 * switch's finite domain does not depend on that arbitrary walk distance. */
.section .text
.globl _start
.type _start, @function
_start:
    movl $1, %edi
    call choose
    movl %eax, %edi
    movl $60, %eax
    syscall
.size _start, .-_start

.type choose, @function
choose:
    cmpl $1, %edi
    ja .Lreject
.Ldispatch:
    leaq .Ltable(%rip), %rdx
    movslq (%rdx,%rdi,4), %rax
    addq %rdx, %rax
    jmp *%rax
.Lzero:
    movl $40, %eax
    ret
.Lone:
    movl $42, %eax
    ret
.Lreject:
    jmp tail
.size choose, .-choose

.type tail, @function
tail:
    .rept 12
    nop
    .endr
#ifdef BYPASS_GUARD
#if BYPASS_GUARD == 2
    testl %edi, %edi
    je .Ltail_return
#endif
    movl $2, %edi
    jmp .Ldispatch
.Ltail_return:
    movl $1, %eax
    ret
#else
    movl $1, %eax
    ret
#endif
.size tail, .-tail

.section .rodata
.p2align 2
.Ltable:
    .long .Lzero - .Ltable
    .long .Lone - .Ltable

.section .note.GNU-stack,"",@progbits
.section .debug_fixture,"",@progbits
.rept 4096
.byte 0
.endr
