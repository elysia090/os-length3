.text
.globl _start
.type _start,@function
_start:
#if defined(CUT_MULTIPLY)
#if CUT_WIDTH == 16
#define DEST %ax
#define SOURCE %di
#elif CUT_WIDTH == 32
#define DEST %eax
#define SOURCE %edi
#else
#define DEST %rax
#define SOURCE %rdi
#endif
#if CUT_MULTIPLY_CASE == 1
    imul DEST,DEST
#elif CUT_MULTIPLY_CASE == 2
    imul $56,SOURCE,DEST
#elif CUT_MULTIPLY_CASE == 3
    imul $-128,SOURCE,DEST
#elif CUT_MULTIPLY_CASE == 4
    imul $0x123456,SOURCE,DEST
#elif CUT_MULTIPLY_CASE == 5
    imul $-1,SOURCE,DEST
#elif CUT_MULTIPLY_CASE == 6
    imul $0,SOURCE,DEST
#elif CUT_MULTIPLY_CASE == 7
    imul $56,DEST,DEST
#elif CUT_MULTIPLY_CASE == 8
    imul SOURCE,DEST
    seto %dl
    setb %sil
    xor %r8d,%r8d
#elif CUT_MULTIPLY_CASE == 9
    imul SOURCE,DEST
    add %rdx,%rsi
#elif CUT_MULTIPLY_CASE == 10
#if CUT_WIDTH == 16
    imul %r8w,%r9w
#elif CUT_WIDTH == 32
    imul %r8d,%r9d
#else
    imul %r8,%r9
#endif
    mov %r9,%rax
#else
    imul SOURCE,DEST
#endif
#elif defined(CUT_CARRY)
#if CUT_WIDTH == 8
#define DEST %al
#define SOURCE %cl
#elif CUT_WIDTH == 16
#define DEST %ax
#define SOURCE %cx
#elif CUT_WIDTH == 32
#define DEST %eax
#define SOURCE %ecx
#else
#define DEST %rax
#define SOURCE %rcx
#endif
#if CUT_CARRY_CASE == 1
    CUT_CARRY DEST,DEST
#elif CUT_CARRY_CASE == 2
    CUT_CARRY $-1,DEST
#elif CUT_CARRY_CASE == 3
    CUT_CARRY %cl,%ah
#elif CUT_CARRY_CASE == 4
#if CUT_WIDTH == 8
    CUT_CARRY %r8b,%r9b
#elif CUT_WIDTH == 16
    CUT_CARRY %r8w,%r9w
#elif CUT_WIDTH == 32
    CUT_CARRY %r8d,%r9d
#else
    CUT_CARRY %r8,%r9
#endif
    mov %r9,%rax
#elif CUT_CARRY_CASE == 5
    add %rdx,%rsi
    CUT_CARRY SOURCE,DEST
    setb %dl
    xor %r8d,%r8d
#elif CUT_CARRY_CASE == 6
    cmp %rdx,%rsi
    CUT_CARRY SOURCE,DEST
    CUT_CARRY $-1,DEST
#elif CUT_CARRY_CASE == 7
    clc
    CUT_CARRY SOURCE,DEST
#elif CUT_CARRY_CASE == 8
    stc
    CUT_CARRY SOURCE,DEST
#else
    CUT_CARRY SOURCE,DEST
#endif
#elif defined(CUT_BIT)
#if CUT_WIDTH == 16
#define DEST %ax
#define SOURCE %di
#elif CUT_WIDTH == 32
#define DEST %eax
#define SOURCE %edi
#else
#define DEST %rax
#define SOURCE %rdi
#endif
#if CUT_BIT_CASE == 1
    CUT_BIT $58,DEST
#elif CUT_BIT_CASE == 2
    CUT_BIT $255,DEST
#elif CUT_BIT_CASE == 3
    CUT_BIT DEST,DEST
#elif CUT_BIT_CASE == 4
    add %rdx,%rsi
    CUT_BIT SOURCE,DEST
    setb %dl
    xor %r8d,%r8d
#else
    CUT_BIT SOURCE,DEST
#endif
#elif defined(CUT_CMOV)
#if CUT_WIDTH == 16
#define DEST %ax
#define SOURCE %di
#elif CUT_WIDTH == 32
#define DEST %eax
#define SOURCE %edi
#else
#define DEST %rax
#define SOURCE %rdi
#endif
#if CUT_CMOV_CASE == 1
    CUT_CMOV DEST,DEST
#elif CUT_CMOV_CASE == 2
    add %rdx,%rsi
    CUT_CMOV SOURCE,DEST
    xor %r8d,%r8d
#elif CUT_CMOV_CASE == 3
    CUT_CMOV %r9d,%ecx
    mov %rcx,%rax
#else
    CUT_CMOV SOURCE,DEST
#endif
#elif defined(CUT_OPCODE)
#if CUT_WIDTH == 8
#define DEST %al
#define SOURCE %cl
#elif CUT_WIDTH == 16
#define DEST %ax
#define SOURCE %cx
#elif CUT_WIDTH == 32
#define DEST %eax
#define SOURCE %ecx
#else
#define DEST %rax
#define SOURCE %rcx
#endif
#ifdef CUT_UNARY
    CUT_OPCODE DEST
#else
    CUT_OPCODE SOURCE,DEST
#endif
#elif defined(CUT_BRANCH)
#if CUT_BRANCH_PREFIX == 1
    lea 25(%rbx),%r8
#elif CUT_BRANCH_PREFIX == 2
    cmp %rsi,%rdi
#endif
    CUT_BRANCH .Ltrue
    mov $0,%eax
    ret
#ifdef CUT_BRANCH_PADDING
.rept CUT_BRANCH_PADDING
    nop
.endr
#endif
.Ltrue:
    mov $1,%eax
    ret
#elif CUT_SPECIAL == 1
    mov %cl,%ah
#elif CUT_SPECIAL == 2
    movsbl %ah,%edx
    mov %edx,%eax
#elif CUT_SPECIAL == 3
    movswq %cx,%r9
    mov %r9,%rax
#elif CUT_SPECIAL == 4
    movzbl %ah,%edx
    mov %edx,%eax
#elif CUT_SPECIAL == 5
    lea -11(%eax,%ecx,8),%r9d
    mov %r9,%rax
#elif CUT_SPECIAL == 6
    lea 7(%rip),%r10
    mov %r10,%rax
#elif CUT_SPECIAL == 7
    movabs $0xf123456789abcdef,%r12
    mov %r12,%rax
#elif CUT_SPECIAL == 8
    add $-127,%rax
#elif CUT_SPECIAL == 9
    sub $-1,%r8
    mov %r8,%rax
#elif CUT_SPECIAL == 10
    mov %ah,%cl
    mov %rcx,%rax
#elif CUT_SPECIAL == 11
    mov $0,%eax
#elif CUT_SPECIAL == 12
    add %rcx,%rax
    inc %rax
#elif CUT_SPECIAL == 13
    add %rcx,%rax
    not %rax
#elif CUT_SPECIAL == 14
    xor %ecx,%eax
    inc %ah
#elif CUT_SPECIAL == 15
    inc %ax
    dec %al
#elif CUT_SPECIAL == 16
    cld
#elif CUT_SPECIAL == 17
    std
#elif CUT_SPECIAL == 18
    std
    add %rcx,%rax
    cld
#elif CUT_SPECIAL == 19
    cld
    std
    inc %ax
#elif CUT_SPECIAL == 20
    stc
    inc %rax
#elif CUT_SPECIAL == 21
    clc
    add %rcx,%rax
#else
    mov %rdi,%rax
    add %rsi,%rax
    xor %dl,%ah
    lea 7(%rax,%rcx,4),%r8
    mov %r8,%rax
#endif
    /* Force defined flags to be observable in the ordinary x86 output. The
     * Wasm compiler stops before this memory transfer; its test oracle replaces
     * the boundary with RET only in a private instrumented executable mapping. */
    pushfq
    pop %r11
    ret
.size _start,.-_start

/* Unreachable padding makes the linked input strictly larger without changing
 * the observable cut. Publication still runs the ordinary post-link proof. */
.rept 4096
    nop
.endr
.section .note.GNU-stack,"",@progbits
