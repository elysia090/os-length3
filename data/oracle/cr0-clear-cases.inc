/* Independent privileged CPU fixture, sharing the existing long-mode boot. */
    xor %r12d,%r12d
cr0_clear_case:
    mov %cr0,%rax
    mov %rax,%r13
    and $-47,%eax
    mov %r12d,%ecx
    and $7,%ecx
    shl $1,%ecx
    or %ecx,%eax
    mov %r12d,%ecx
    and $8,%ecx
    shl $2,%ecx
    or %ecx,%eax
    mov %rax,%cr0
    mov %rax,record+8(%rip)
    mov %r12,record(%rip)
    mov %r12d,%eax
    shr $4,%eax
    lea cr0_clear_targets(%rip),%rsi
    mov (%rsi,%rax,8),%eax
    pushq $0x8d7
    popfq
    pushfq
    pop %r8
    call *%rax
    pushfq
    pop %r9
    mov %cr0,%rax
    mov %rax,record+16(%rip)
    mov %r8,record+24(%rip)
    mov %r9,record+32(%rip)
    mov %r13,%cr0
    lea record(%rip),%rsi
    mov $5,%r14d
cr0_clear_word:
    lodsq
    mov $16,%ecx
cr0_clear_digit:
    rol $4,%rax
    mov %al,%dl
    and $15,%dl
    add $48,%dl
    cmp $58,%dl
    jb cr0_clear_ascii
    add $39,%dl
cr0_clear_ascii:
    push %rax
    mov %dl,%al
    out %al,$0xe9
    pop %rax
    loop cr0_clear_digit
    mov $32,%al
    out %al,$0xe9
    dec %r14d
    jnz cr0_clear_word
    mov $10,%al
    out %al,$0xe9
    inc %r12d
    cmp $128,%r12d
    jb cr0_clear_case
    mov $0x10,%eax
    out %eax,$0xf4
    hlt
cr0_clear_0: .byte 0x0f,6,0xc3
cr0_clear_1: .byte 0x66,0x0f,6,0xc3
cr0_clear_2: .byte 0x67,0x0f,6,0xc3
cr0_clear_3: .byte 0x48,0x0f,6,0xc3
cr0_clear_4: .byte 0xf2,0x0f,6,0xc3
cr0_clear_5: .byte 0xf3,0x0f,6,0xc3
cr0_clear_6: .byte 0x64,0x0f,6,0xc3
cr0_clear_7: .byte 0x65,0x0f,6,0xc3
.pushsection .rodata,"a"
.balign 8
cr0_clear_targets:
.long cr0_clear_0,0,cr0_clear_1,0,cr0_clear_2,0,cr0_clear_3,0
.long cr0_clear_4,0,cr0_clear_5,0,cr0_clear_6,0,cr0_clear_7,0
.popsection
