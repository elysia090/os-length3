.section .text
.globl sum
.type sum, @function
sum:
    leal 3(%rdi,%rsi), %eax
    ret
.size sum, .-sum
.section .data
.p2align 3
    .quad sum
.section .note.GNU-stack,"",@progbits
