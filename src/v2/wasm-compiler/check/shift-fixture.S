.text
.globl _start
.type _start,@function
_start:
#if SHIFT_WIDTH == 8
#define DEST %al
#elif SHIFT_WIDTH == 16
#define DEST %ax
#elif SHIFT_WIDTH == 32
#define DEST %eax
#else
#define DEST %rax
#endif
#if defined(SHIFT_OPCODE)
#ifdef SHIFT_COUNT
    SHIFT_OPCODE $ (SHIFT_COUNT),DEST
#else
    SHIFT_OPCODE %cl,DEST
#endif
#elif SHIFT_CASE == 1
    add %rdx,%rax
    shl %cl,%rax
#elif SHIFT_CASE == 2
    and %rdx,%rax
    shr %cl,%rax
#elif SHIFT_CASE == 3
    add %rdx,%rax
    shl %cl,%rax
    sar %cl,%rax
#elif SHIFT_CASE == 4
    stc
    shl %cl,%ax
    inc %ax
#elif SHIFT_CASE == 5
    shr %cl,%rax
    add %rdx,%rax
#elif SHIFT_CASE == 6
    shl %cl,%cl
    mov %rcx,%rax
#elif SHIFT_CASE == 7
    sar %cl,%ch
    mov %rcx,%rax
#elif SHIFT_CASE == 8
    sar %cl,%r9d
    mov %r9,%rax
#elif SHIFT_CASE == 9
    add %rdx,%rax
    shl $0,%eax
#elif SHIFT_CASE == 10
    add %rdx,%rax
    shr $32,%eax
#elif SHIFT_CASE == 11
    xor %rdx,%rax
    shl %cl,%ah
#elif SHIFT_CASE == 12
    shr $1,%r15
    sar %cl,%r15
    dec %r15
    mov %r15,%rax
#elif SHIFT_CASE == 13
    rol %cl,%cl
    mov %rcx,%rax
#elif SHIFT_CASE == 14
    ror %cl,%ch
    mov %rcx,%rax
#elif SHIFT_CASE == 15
    rol %cl,%r9d
    mov %r9,%rax
#elif SHIFT_CASE == 16
    add %rdx,%rax
    rol %cl,%ax
#elif SHIFT_CASE == 17
    and %rdx,%rax
    ror %cl,%rax
#elif SHIFT_CASE == 18
    rol %cl,%ax
    setc %dl
    xor %r8d,%r8d
#elif SHIFT_CASE == 19
    ror %cl,%rax
    setc %dl
    xor %r8d,%r8d
#elif SHIFT_CASE == 20
    rol $16,%ax
#elif SHIFT_CASE == 21
    ror $8,%ah
#elif SHIFT_CASE == 22
    xor %rdx,%rax
    rol $0,%eax
#elif SHIFT_CASE == 23
    add %rdx,%rax
    ror $32,%eax
#elif SHIFT_CASE == 24
    rol $1,%r15
    ror %cl,%r15
    dec %r15
    mov %r15,%rax
#elif SHIFT_CASE == 25
    rol %cl,%ax
    setz %dl
#elif SHIFT_CASE == 26
    ror %cl,%rax
    adc %rcx,%rax
#else
#error unknown shift fixture
#endif
    /* A legal zero-count normalization may erase a narrow identity shift.
     * Keep a flag-neutral observable transfer so that prefix is still tested. */
    lea 1(%rax),%rax
    /* The native oracle observes this exact prefix. Its private mapping
     * replaces only the following PUSHFQ boundary with RET. */
    pushfq
    pop %r11
    ret
.size _start,.-_start
.rept 4096
    nop
.endr
.section .note.GNU-stack,"",@progbits
