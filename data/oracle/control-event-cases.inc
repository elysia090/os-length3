/* Independent INT/FWAIT observations, sharing the existing boot scaffolding.
 * Generated gate stubs only identify the processor-delivered vector. */
    xor %r12d,%r12d
event_case:
    cli
    cld
    lea event_record(%rip),%rdi
    xor %eax,%eax
    mov $28,%ecx
    rep stosq
    mov %r12,event_record(%rip)
    mov %cr0,%rax
    and $-15,%rax
    or $32,%rax
    mov %rax,%cr0
    fninit
    mov $0x400,%eax
    mov %rax,%dr7
    mov $0xffff0fff,%eax
    mov %rax,%dr6
    mov %dr6,%rax
    mov %rax,event_record+152(%rip)
    mov %dr7,%rax
    mov %rax,event_record+168(%rip)
    mov %r12d,%eax
    and $1,%eax
    add $0x8e,%eax
    mov %eax,%r13d
    xor %r14d,%r14d
event_gate_loop:
    lea event_handlers(%rip),%rbx
    mov (%rbx,%r14,4),%esi
    mov %r14d,%ecx
    call install_gate
    mov %r14d,%ecx
    shl $4,%ecx
    lea idt(%rip),%rbx
    mov %r13b,5(%rbx,%rcx)
    inc %r14d
    cmp $256,%r14d
    jb event_gate_loop
    lea event_code(%rip),%rdi
    cmp $1024,%r12d
    jae event_wait
    mov %r12d,%eax
    shr $2,%eax
    mov %rax,event_record+16(%rip)
    movb $0xcd,(%rdi)
    mov %al,1(%rdi)
    mov $2,%r15d
    jmp event_source_ready
event_wait:
    movq $1,event_record+8(%rip)
    mov %r12d,%r14d
    sub $1024,%r14d
    test $1,%r14d
    jz event_wait_no_pending
    fldcw event_unmasked(%rip)
    fldz
    fldz
    fdivp %st,%st(1)
event_wait_no_pending:
    mov %r14d,%eax
    shr $1,%eax
    and $7,%eax
    shl $1,%eax
    mov %cr0,%rdx
    or %rax,%rdx
    mov %rdx,%cr0
    mov %r14d,%eax
    shr $4,%eax
    mov %rax,event_record+24(%rip)
    xor %r15d,%r15d
    test %eax,%eax
    jz event_wait_plain
    lea event_prefixes(%rip),%rdx
    mov (%rdx,%rax),%al
    mov %al,(%rdi)
    inc %r15d
event_wait_plain:
    movb $0x9b,(%rdi,%r15)
    inc %r15d
event_source_ready:
    movb $0xe9,(%rdi,%r15)
    lea event_resume(%rip),%rax
    sub %rdi,%rax
    sub %r15,%rax
    sub $5,%rax
    mov %eax,1(%rdi,%r15)
    mov %rdi,event_record+64(%rip)
    mov %r15,event_record+72(%rip)
    mov %cr0,%rax
    mov %rax,event_record+32(%rip)
    /* FNSTCW/SW are no-wait, but may themselves #NM with EM/TS. Capture
     * before setting those bits by temporarily restoring the same CR0. */
    mov %rax,%rdx
    and $-15,%rax
    mov %rax,%cr0
    fnstcw event_record+40(%rip)
    fnstsw event_record+48(%rip)
    mov %rdx,%cr0
    mov $0x603,%edx
    test $2,%r12d
    jz event_flags_ready
    or $0x10000,%edx
event_flags_ready:
    mov %rdx,event_record+56(%rip)
    mov $stack_end,%eax
    mov %r12d,%ecx
    and $15,%ecx
    sub %rcx,%rax
    mov %rax,event_record+80(%rip)
    pushq $16
    push %rax
    push %rdx
    pushq $8
    push %rdi
    iretq
event_resume:
    cli
    cld
    /* Successful WAIT has no handler. Fault handlers capture the FPU before
     * clearing the pending error, so neither observer path waits recursively. */
    cmpq $0,event_record+144(%rip)
    jne event_print
    mov %cr0,%rax
    and $-15,%rax
    mov %rax,%cr0
    fnstcw event_record+208(%rip)
    fnstsw event_record+216(%rip)
event_print:
    lea event_record(%rip),%rsi
    mov $28,%r8d
event_print_word:
    lodsq
    mov $16,%ecx
event_hex_digit:
    rol $4,%rax
    mov %al,%dl
    and $15,%dl
    add $48,%dl
    cmp $58,%dl
    jb event_emit
    add $39,%dl
event_emit:
    xchg %al,%dl
    out %al,$0xe9
    xchg %al,%dl
    loop event_hex_digit
    mov $32,%al
    out %al,$0xe9
    dec %r8d
    jnz event_print_word
    mov $10,%al
    out %al,$0xe9
    mov $stack_end,%esp
    inc %r12d
    cmp $1152,%r12d
    jb event_case
    mov $0x10,%eax
    out %eax,$0xf4
    hlt
event_handler:
    push %rax
    pushfq
    popq event_record+136(%rip)
    mov 8(%rsp),%rax
    mov %rax,event_record+88(%rip)
    lea 16(%rsp),%rax
    mov %rax,event_record+144(%rip)
    push %rsi
    push %rdi
    push %rcx
    lea event_handlers(%rip),%rdi
    mov 32(%rsp),%rcx
    mov (%rdi,%rcx,4),%edi
    mov %rdi,event_record+200(%rip)
    mov %rax,%rsi
    lea event_record+96(%rip),%rdi
    mov $5,%ecx
    cld
    rep movsq
    mov %dr6,%rax
    mov %rax,event_record+160(%rip)
    mov %dr7,%rax
    mov %rax,event_record+176(%rip)
    mov %cr0,%rax
    and $-15,%rax
    mov %rax,%cr0
    fnstcw event_record+208(%rip)
    fnstsw event_record+216(%rip)
    fnclex
    lea event_resume(%rip),%rax
    mov %rax,40(%rsp)
    pop %rcx
    pop %rdi
    pop %rsi
    pop %rax
    add $8,%rsp
    iretq
.altmacro
.macro event_stub number
event_stub_\number:
    pushq $\number
    jmp event_handler
.endm
.set event_number,0
.rept 256
    event_stub %event_number
    .set event_number,event_number+1
.endr
.pushsection .rodata,"a"
event_unmasked: .word 0x37e
event_prefixes: .byte 0,0x66,0x67,0x48,0x64,0x65,0xf2,0xf3
.macro event_address number
    .long event_stub_\number
.endm
event_handlers:
.set event_number,0
.rept 256
    event_address %event_number
    .set event_number,event_number+1
.endr
.noaltmacro
.popsection
.pushsection .bss,"aw",@nobits
.balign 16
event_record: .skip 224
event_code: .skip 32
.popsection
