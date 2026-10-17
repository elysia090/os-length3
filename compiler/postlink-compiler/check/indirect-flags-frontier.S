/* An indirect jump preserves flags for its target's first conditional.
 * The relocation identifies the jump table, not a complete set of outgoing
 * liveness edges. Retaining its value lanes must not erase that flag demand. */
.section .text
.globl _start
.type _start, @function
_start:
    movl $1, %edi
    xorl %esi, %esi
    call choose
    movl %eax, %edi
    movl $60, %eax
    syscall
.size _start, .-_start

.type choose, @function
choose:
    cmpl $2, %edi
    ja .Lbad
    movl %edi, %edi
    testl %esi, %esi
    jmp *.Ltable(,%rdi,8)
.Lzero:
    je .Lgood
    jmp .Lbad
.Lone:
    je .Lgood
    jmp .Lbad
.Ltwo:
    je .Lgood
.Lbad:
    movl $1, %eax
    ret
.Lgood:
    movl $42, %eax
    ret
.size choose, .-choose

.section .rodata
.p2align 3
.Ltable:
    .quad .Lzero, .Lone, .Ltwo
.section .note.GNU-stack,"",@progbits
.section .debug_fixture,"",@progbits
.rept 4096
.byte 0
.endr
