.text
.globl _start
.type _start,@function
_start:
#ifdef CONDITION_OPCODE
#ifdef CONDITION_SEED
    cmp %rsi,%rdi
#endif
    CONDITION_OPCODE % CONDITION_REGISTER
    mov % CONDITION_PARENT,%rax
#ifdef CONDITION_SEED
    /* The condition observes the CMP, not this later complete flag kill. */
    add %rdx,%rax
#endif
#elif CONDITION_CASE == 1
    add %rdx,%rax
    setb %ah
    sub %rsi,%rax
#elif CONDITION_CASE == 2
    xor %edx,%eax
    setp %ah
    inc %rax
#elif CONDITION_CASE == 3
    add %rdx,%rax
    shl %cl,%rax
    setz %ah
    and $65535,%rax
#elif CONDITION_CASE == 4
    shl %cl,%al
    setz %ah
    add %rdx,%rax
#elif CONDITION_CASE == 5
    cmp %rdi,%rsi
    setb %r9b
    cmp %rdx,%rax
    setl %ah
    movzbl %r9b,%edx
    lea (%rax,%rdx,2),%rax
#elif CONDITION_CASE == 6
    cmp %rsi,%rdi
    seto %al
    shl $1,%al
#else
#error unknown conditional-result fixture
#endif
    lea 1(%rax),%rax
    pushfq
    pop %r11
    ret
.size _start,.-_start
.rept 4096
    nop
.endr
.section .note.GNU-stack,"",@progbits
