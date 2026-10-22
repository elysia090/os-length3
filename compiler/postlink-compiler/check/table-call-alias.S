.section .text,"ax",@progbits
.global _start
.type _start,@function
_start:
    xor %r12d, %r12d
    xor %r13d, %r13d
.Lnext:
    mov %r12d, %esi
    call choose
    add %eax, %r13d
    inc %r12d
    cmp $5, %r12d
    jne .Lnext
    cmp $116, %r13d
    jne .Lfailed
    mov $42, %edi
    jmp .Lexit
.Lfailed:
    mov $1, %edi
.Lexit:
    mov $60, %eax
    syscall
.size _start, .-_start

/* Two indirect joins, a private spill, and a caller-saved value preserved
 * by the actual linked leaf. The second guard is not on the index register. */
.type choose,@function
choose:
    push %rbp
    mov %rsp, %rbp
    sub $16, %rsp
    mov %esi, %r10d
    mov %r10d, %eax
    mov %rax, -8(%rbp)
#ifdef ESCAPED_SPILL
    lea -8(%rbp), %rdi
#endif
    call leaf
    mov -8(%rbp), %rax
    mov %esi, %edx
    and $1, %edx
    lea .Lfirst(%rip), %rcx
    movslq (%rcx,%rdx,4), %rdx
    add %rcx, %rdx
    jmp *%rdx
.Lfirst0:
    nop
    jmp .Lguard
.Lfirst1:
    nop
.Lguard:
    cmp $4, %r10d
    ja .Ldefault
    lea .Lsecond(%rip), %rdx
    movslq (%rdx,%rax,4), %rax
    add %rdx, %rax
    jmp *%rax
.Lcase0: mov $7, %eax; jmp .Lreturn
.Lcase1: mov $13, %eax; jmp .Lreturn
.Lcase2: mov $22, %eax; jmp .Lreturn
.Lcase3: mov $31, %eax; jmp .Lreturn
.Lcase4: mov $43, %eax; jmp .Lreturn
.Ldefault: xor %eax, %eax
.Lreturn:
    leave
    ret
.size choose, .-choose

.type leaf,@function
leaf:
#ifdef MID_INSTRUCTION_CLOBBER
    jmp .Linterior
    .byte 0xb8
.Linterior:
    /* Lexically MOV EAX,imm32; entering its immediate executes XOR R10D,R10D. */
    .byte 0x45, 0x31, 0xd2, 0x90
#endif
    xor %eax, %eax
#ifdef ESCAPED_SPILL
    movq $9, (%rdi)
#endif
#ifdef CLOBBER_ALIAS
    xor %r10d, %r10d
#endif
    ret
.size leaf, .-leaf

.section .rodata,"a",@progbits
.balign 4
.Lfirst: .long .Lfirst0-.Lfirst, .Lfirst1-.Lfirst
.Lsecond:
    .long .Lcase0-.Lsecond, .Lcase1-.Lsecond, .Lcase2-.Lsecond
    .long .Lcase3-.Lsecond, .Lcase4-.Lsecond
.section .text.unreachable,"ax",@progbits
.fill 4096,1,0xcc
.section .note.GNU-stack,"",@progbits
