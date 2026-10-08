/* Privileged debug-register oracle, not a product backend. */
.section .multiboot,"a"
.balign 4
.long 0x1badb002, 0, -0x1badb002
.section .text,"ax"
.code32
.global _start
_start:
    cli
    mov $0xff,%al
    out %al,$0x21
    out %al,$0xa1
    lgdt gdt_pointer
    mov $0x10, %ax
    mov %ax, %ds
    mov %ax, %es
    mov %ax, %ss
    mov $stack_end, %esp
    mov $pml4, %eax
    mov %eax, %cr3
    mov $pdpt, %eax
    or $3, %eax
    mov %eax, pml4
    mov $pd, %eax
    or $3, %eax
    mov %eax, pdpt
    movl $0x83, pd
    mov %cr4, %eax
    or $0x20, %eax
    mov %eax, %cr4
    mov $0xc0000080, %ecx
    rdmsr
    or $0x100, %eax
    wrmsr
    mov %cr0, %eax
    or $0x80000001, %eax
    mov %eax, %cr0
    ljmp $8, $long_start
.code64
long_start:
    lea debug_db(%rip),%rsi
    mov $1,%ecx
    call install_gate
    lea debug_gp(%rip),%rsi
    mov $13,%ecx
    call install_gate
    lidt idt_pointer(%rip)
.ifdef control_event_oracle
    .include "data/oracle/control-event-cases.inc"
.else
.ifdef debug_trap_oracle
    /* Reuse this oracle's Multiboot/long-mode/IDT setup, not another machine. */
    .include "data/oracle/debug-trap-cases.inc"
.else
    xor %r12d,%r12d
case_loop:
    xor %eax,%eax
    mov %rax,%dr0
    mov %rax,%dr1
    mov %rax,%dr2
    mov %rax,%dr3
    mov $0x400,%eax
    mov %rax,%dr7
    mov $0xffff0ff0,%eax
    mov %rax,%dr6
    lea record(%rip),%rdi
    mov %r12,(%rdi)
    movq $1,8(%rdi)
    movq $0,88(%rdi)
    mov %r12d,%eax
    cmp $576,%eax
    jae gd_case
    xor %edx,%edx
    mov $72,%ecx
    div %ecx
    mov %eax,%r13d
    mov %eax,16(%rdi)
    mov %edx,%ecx
    cmp $64,%edx
    jae boundary
    mov $1,%eax
    shl %cl,%rax
    jmp value_ready
boundary:
    sub $64,%edx
    mov values(,%edx,8),%rax
value_ready:
    cmp $5,%r13d
    je safe_dr7
    cmp $7,%r13d
    jne transfer
safe_dr7:
    /* Keep GD/address enables separate from the transfer under observation.
     * High reserved bits still reach the real #GP boundary. */
    and $-8448,%rax
    jmp transfer
gd_case:
    sub $576,%eax
    mov %eax,%r13d
    and $7,%r13d
    mov %r13,16(%rdi)
    cmp $8,%eax
    jae gd_write
    movq $0,8(%rdi)
gd_write:
    mov $0x2400,%eax
    mov %rax,%dr7
    mov $0x12345678,%eax
transfer:
    mov %rax,24(%rdi)
    pushq $0x202
    popfq
    pushfq
    popq 96(%rdi)
    cmpq $0,8(%rdi)
    je do_read
    lea write_table(%rip),%r14
    mov (%r14,%r13,4),%r14d
    call *%r14
    jmp observe
do_read:
    lea read_table(%rip),%r14
    mov (%r14,%r13,4),%r14d
    call *%r14
observe:
    mov %rax,32(%rdi)
    mov %dr0,%rax
    mov %rax,40(%rdi)
    mov %dr1,%rax
    mov %rax,48(%rdi)
    mov %dr2,%rax
    mov %rax,56(%rdi)
    mov %dr3,%rax
    mov %rax,64(%rdi)
    mov %dr6,%rax
    mov %rax,72(%rdi)
    mov %dr7,%rax
    mov %rax,80(%rdi)
    cli
    cld
    lea record(%rip),%rsi
    mov $13,%r8d
print_word:
    lodsq
    mov $16,%ecx
hex_digit:
    rol $4,%rax
    mov %al,%dl
    and $15,%dl
    add $48,%dl
    cmp $58,%dl
    jb emit
    add $39,%dl
emit:
    xchg %al,%dl
    out %al,$0xe9
    xchg %al,%dl
    loop hex_digit
    mov $32,%al
    out %al,$0xe9
    dec %r8d
    jnz print_word
    mov $10,%al
    out %al,$0xe9
    inc %r12d
    cmp $592,%r12d
    jb case_loop
    mov $0x10,%eax
    out %eax,$0xf4
    hlt
.endif
.endif
install_gate:
    lea idt(%rip),%rdi
    shl $4,%ecx
    add %rcx,%rdi
    mov %si,(%rdi)
    movw $8,2(%rdi)
    movb $0x8e,5(%rdi)
    shr $16,%rsi
    mov %si,6(%rdi)
    ret
debug_db:
    push %rax
    movq $1,record+88(%rip)
    lea fault_resume(%rip),%rax
    mov %rax,8(%rsp)
    pop %rax
    iretq
debug_gp:
    push %rax
    movq $13,record+88(%rip)
    lea fault_resume(%rip),%rax
    mov %rax,16(%rsp)
    pop %rax
    add $8,%rsp
    iretq
fault_resume:
    ret
.irp rank,0,1,2,3,4,5,6,7
write_\rank:
    .byte 0x0f,0x23,0xc0+(\rank*8)
    ret
read_\rank:
    .byte 0x0f,0x21,0xc0+(\rank*8)
    ret
.endr
.section .rodata,"a"
.balign 8
gdt: .quad 0,0x00af9b000000ffff,0x00cf93000000ffff
gdt_pointer: .word 23
    .long gdt
write_table:
.irp rank,0,1,2,3,4,5,6,7
    .long write_\rank
.endr
read_table:
.irp rank,0,1,2,3,4,5,6,7
    .long read_\rank
.endr
values: .quad 0,1,-1,0x400,0xffff0ff0,0x800000000000,0xffff800000000000,0x123456789abcdef0
idt_pointer: .word 4095
    .long idt,0
.section .bss,"aw",@nobits
.balign 4096
pml4: .skip 4096
pdpt: .skip 4096
pd: .skip 4096
idt: .skip 4096
record: .skip 104
.balign 16
stack: .skip 8192
stack_end:
.section .note.GNU-stack,"",@progbits
