.intel_syntax noprefix
.text
.global _start
.type _start,@function
_start:
#if STACK_CASE == 0
    push rax
#elif STACK_CASE == 1
    push rsp
#elif STACK_CASE == 2
    push r12
#elif STACK_CASE == 3
    push -127
#elif STACK_CASE == 4
    push -2147483647
#elif STACK_CASE == 5
    pop rax
#elif STACK_CASE == 6
    pop rsp
#elif STACK_CASE == 7
    pop r12
#elif STACK_CASE == 8
    call target
#elif STACK_CASE == 9
    ret
#elif STACK_CASE == 10
    ret 65528
#else
#error unknown stack case
#endif
    .rept 32
    nop
    .endr
target:
    ret
.size _start,.-_start
.section .note.GNU-stack,"",@progbits
