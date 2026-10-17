/* An address-producing value tree may preserve flags at each leaf yet finish
 * with ADD. The final comparison must follow that complete native spelling. */
.section .text
.globl _start
.type _start, @function
_start:
    leaq .Ldata(%rip), %rbx
#if COMPARE_ADDRESS_CASE == 2
    movl $255, %r9d
#else
    movl $256, %r9d
#endif
    movl $256, %r12d
    call choose
    movl %eax, %edi
    movl $60, %eax
    syscall
.size _start, .-_start

.type choose, @function
choose:
    movslq %r9d, %r8
    addq %rbx, %r8
    cmpl %r9d, %r12d
#if COMPARE_ADDRESS_CASE == 1
    je .Lgood
#elif COMPARE_ADDRESS_CASE == 2
    jg .Lgood
#elif COMPARE_ADDRESS_CASE == 3
    jbe .Lgood
#else
    jle .Lgood
#endif
    movl $1, %eax
    ret
.Lgood:
    movslq %r9d, %rax
    addq %rbx, %rax
    cmpq %rax, %r8
    jne .Lbad
    movl $42, %eax
    ret
.Lbad:
    movl $1, %eax
    ret
.size choose, .-choose

.section .rodata
.Ldata:
    .byte 0
.section .note.GNU-stack,"",@progbits
.section .debug_fixture,"",@progbits
.rept 4096
.byte 0
.endr
