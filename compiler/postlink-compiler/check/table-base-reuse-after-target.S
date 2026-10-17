/* BusyBox's route option switch prepares an argument in the old table-base
 * register after forming its target. The target remains in RAX. */
.section .text
.globl _start
.type _start, @function
_start:
    movl (%rsp), %eax
    subl $1, %eax
    cmpl $12, %eax
    ja .Lbad
    leaq .Lstate(%rip), %rbx
    leaq .Ltable(%rip), %rdx
    movslq (%rdx,%rax,4), %rax
    addq %rdx, %rax
#ifdef BREAK_TARGET
    leaq 8(%rbx), %rax
#else
    leaq 8(%rbx), %rdx
#endif
    jmp *%rax
.Lcase0: movl $42, %edi; jmp .Lexit
.Lcase1: movl $43, %edi; jmp .Lexit
.Lcase2: movl $44, %edi; jmp .Lexit
.Lcase3: movl $45, %edi; jmp .Lexit
.Lcase4: movl $46, %edi; jmp .Lexit
.Lcase5: movl $47, %edi; jmp .Lexit
.Lcase6: movl $48, %edi; jmp .Lexit
.Lcase7: movl $49, %edi; jmp .Lexit
.Lcase8: movl $50, %edi; jmp .Lexit
.Lcase9: movl $51, %edi; jmp .Lexit
.Lcase10: movl $52, %edi; jmp .Lexit
.Lcase11: movl $53, %edi; jmp .Lexit
.Lcase12: movl $54, %edi; jmp .Lexit
.Lbad: movl $1, %edi
.Lexit: movl $60, %eax; syscall
.size _start, .-_start
.section .rodata
.p2align 2
.Ltable:
    .long .Lcase0-.Ltable, .Lcase1-.Ltable, .Lcase2-.Ltable
    .long .Lcase3-.Ltable, .Lcase4-.Ltable, .Lcase5-.Ltable
    .long .Lcase6-.Ltable, .Lcase7-.Ltable, .Lcase8-.Ltable
    .long .Lcase9-.Ltable, .Lcase10-.Ltable, .Lcase11-.Ltable
    .long .Lcase12-.Ltable
.section .data
.Lstate: .zero 16
.section .note.GNU-stack,"",@progbits
.section .debug_fixture,"",@progbits
.zero 4096
