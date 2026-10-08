/* Included by the existing privileged debug oracle, not product execution.
 * Observe INT1 before any handler changes its frame; no result is predicted. */
    lea trap_handler(%rip),%rsi
    mov $1,%ecx
    call install_gate
.ifdef debug_trap_faults
    lea trap_np(%rip),%rsi
    mov $11,%ecx
    call install_gate
    lea trap_gp(%rip),%rsi
    mov $13,%ecx
    call install_gate
.endif
    xor %r12d,%r12d
trap_case_loop:
    cli
    cld
    mov $0x400,%eax
    mov %rax,%dr7
    mov %r12d,%eax
    shr $3,%eax
    xor %edx,%edx
    mov $3,%ecx
    div %ecx
    mov %edx,%r15d
    mov %eax,%r13d
    mov %r12d,%r14d
    and $7,%r14d
    lea trap_record(%rip),%rdi
    xor %eax,%eax
    mov $25,%ecx
    rep stosq
    lea trap_record(%rip),%rdi
    lea trap_handler(%rip),%rax
    mov %rax,184(%rdi)
    mov %r12,(%rdi)
    mov %r14,8(%rdi)
    mov %r15,16(%rdi)
    mov %r13d,%eax
    shr $4,%eax
    and $1,%eax
    add $0x8e,%eax
    mov %al,idt+21(%rip)
    mov %rax,24(%rdi)
    movw $8,idt+18(%rip)
.ifdef debug_trap_faults
    mov %r13d,%ecx
    shr $1,%ecx
    and $3,%ecx
    cmp $1,%ecx
    jne 1f
    andb $0x7f,idt+21(%rip)
1:  cmp $2,%ecx
    jne 2f
    movb $0x8d,idt+21(%rip)
2:  cmp $3,%ecx
    jne 3f
    movw $24,idt+18(%rip)
3:
.endif
    mov %r13d,%ecx
    shr $1,%ecx
    and $3,%ecx
    mov trap_dr6(,%ecx,8),%rax
    mov %rax,%dr6
    mov %dr6,%rax
    mov %rax,48(%rdi)
    mov %r13d,%eax
    shr $3,%eax
    and $1,%eax
    shl $13,%eax
    or $0x400,%eax
    mov %rax,56(%rdi)
    mov %rax,%dr7
    mov $0x603,%eax
    cmp $2,%r15d
    jne trap_flags_ready
    and $-513,%eax
trap_flags_ready:
    mov %r13d,%ecx
    and $1,%ecx
    shl $16,%ecx
    or %ecx,%eax
    mov %rax,40(%rdi)
    lea (%r14,%r14,2),%ecx
    add %r15d,%ecx
    mov trap_coordinates(,%ecx,4),%edx
    mov %rdx,64(%rdi)
    mov $1,%edx
    test %r14d,%r14d
    jz trap_length_ready
    inc %edx
trap_length_ready:
    mov %rdx,72(%rdi)
    mov trap_entries(,%ecx,4),%edx
    mov $stack_end,%esp
    mov %r12d,%ecx
    and $15,%ecx
    sub %rcx,%rsp
    mov %rsp,32(%rdi)
    mov %rsp,%rcx
    pushq $16
    push %rcx
    push %rax
    pushq $8
    push %rdx
    mov $16,%eax
    iretq
trap_resume:
    pushfq
    popq trap_record+168(%rip)
    mov %rsp,trap_record+160(%rip)
    cli
    cld
    lea trap_record(%rip),%rsi
    mov $25,%r8d
trap_print_word:
    lodsq
    mov $16,%ecx
trap_hex_digit:
    rol $4,%rax
    mov %al,%dl
    and $15,%dl
    add $48,%dl
    cmp $58,%dl
    jb trap_emit
    add $39,%dl
trap_emit:
    xchg %al,%dl
    out %al,$0xe9
    xchg %al,%dl
    loop trap_hex_digit
    mov $32,%al
    out %al,$0xe9
    dec %r8d
    jnz trap_print_word
    mov $10,%al
    out %al,$0xe9
    inc %r12d
    cmp $768,%r12d
    jb trap_case_loop
    mov $0x10,%eax
    out %eax,$0xf4
    hlt
trap_handler:
    push %rax
    push %rcx
    push %rsi
    push %rdi
    pushfq
    pop %rax
    cmpq $0,trap_record+80(%rip)
    jne trap_nested
    mov %rax,trap_record+120(%rip)
    movq $1,trap_record+80(%rip)
    lea 32(%rsp),%rsi
    mov %rsi,trap_record+128(%rip)
    mov (%rsi),%rax
    mov %rax,trap_record+88(%rip)
    mov 16(%rsi),%rax
    mov %rax,trap_record+96(%rip)
    mov 24(%rsi),%rax
    mov %rax,trap_record+104(%rip)
    mov 32(%rsi),%rax
    mov %rax,trap_record+112(%rip)
    mov %dr6,%rax
    mov %rax,trap_record+136(%rip)
    mov %dr7,%rax
    mov %rax,trap_record+144(%rip)
    xor %eax,%eax
    mov %ss,%ax
    mov %rax,trap_record+152(%rip)
    lea trap_resume(%rip),%rax
    mov %rax,(%rsi)
    pop %rdi
    pop %rsi
    pop %rcx
    pop %rax
    iretq
trap_nested:
    /* Do not overwrite the FIRST trap with a debug-register-access fault
     * caused by the observer itself. Return to that read after GD clears. */
    incq trap_record+176(%rip)
    pop %rdi
    pop %rsi
    pop %rcx
    pop %rax
    iretq
.ifdef debug_trap_faults
trap_np:
    pushq $11
    push %rax
    lea trap_np(%rip),%rax
    mov %rax,trap_record+184(%rip)
    pop %rax
    jmp trap_secondary
trap_gp:
    pushq $13
    push %rax
    lea trap_gp(%rip),%rax
    mov %rax,trap_record+184(%rip)
    pop %rax
trap_secondary:
    push %rax
    push %rcx
    push %rsi
    push %rdi
    pushfq
    popq trap_record+120(%rip)
    mov 32(%rsp),%rax
    mov %rax,trap_record+80(%rip)
    lea 40(%rsp),%rsi
    mov %rsi,trap_record+128(%rip)
    mov (%rsi),%rax
    mov %rax,trap_record+192(%rip)
    add $8,%rsi
    mov (%rsi),%rax
    mov %rax,trap_record+88(%rip)
    mov 16(%rsi),%rax
    mov %rax,trap_record+96(%rip)
    mov 24(%rsi),%rax
    mov %rax,trap_record+104(%rip)
    mov 32(%rsi),%rax
    mov %rax,trap_record+112(%rip)
    mov %dr6,%rax
    mov %rax,trap_record+136(%rip)
    mov %dr7,%rax
    mov %rax,trap_record+144(%rip)
    xor %eax,%eax
    mov %ss,%ax
    mov %rax,trap_record+152(%rip)
    lea trap_resume(%rip),%rax
    mov %rax,(%rsi)
    pop %rdi
    pop %rsi
    pop %rcx
    pop %rax
    add $16,%rsp
    iretq
.endif
.macro trap_template number,prefix,shadow
trap_entry_\number\()_\shadow:
.if \shadow == 1
    mov %eax,%ss
.elseif \shadow == 2
    sti
.endif
trap_cut_\number\()_\shadow:
.if \prefix
    .byte \prefix
.endif
    .byte 0xf1
    nop
    jmp trap_resume
.endm
.macro trap_form number,prefix
    trap_template \number,\prefix,0
    trap_template \number,\prefix,1
    trap_template \number,\prefix,2
.endm
trap_form 0,0
trap_form 1,0x66
trap_form 2,0x67
trap_form 3,0x48
trap_form 4,0x64
trap_form 5,0x65
trap_form 6,0xf2
trap_form 7,0xf3
.section .rodata,"a"
trap_entries:
.irp n,0,1,2,3,4,5,6,7
    .long trap_entry_\n\()_0,trap_entry_\n\()_1,trap_entry_\n\()_2
.endr
trap_coordinates:
.irp n,0,1,2,3,4,5,6,7
    .long trap_cut_\n\()_0,trap_cut_\n\()_1,trap_cut_\n\()_2
.endr
trap_dr6: .quad 0xffff0ff0,0xffff0fff,0xffff6ff0,0xffffefff
.section .bss,"aw",@nobits
.balign 8
trap_record: .skip 200
.section .text,"ax"
