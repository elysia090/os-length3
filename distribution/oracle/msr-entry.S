/* System-mode MSR oracle only. These instructions run in QEMU TCG, never
 * as a product execution backend. Fault/privilege coverage is separate. */
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
    xor %r12d, %r12d
.ifdef MISC_CASES
    jmp misc_loop
.endif
.ifdef SYSCALL_CASES
    lea syscall_gp(%rip),%rsi
    lea syscall_idt+13*16(%rip),%rdi
    mov %si,(%rdi)
    movw $8,2(%rdi)
    movb $0,4(%rdi)
    movb $0x8e,5(%rdi)
    mov %esi,%edx
    shr $16,%edx
    mov %dx,6(%rdi)
    movq $0,8(%rdi)
    lidt syscall_idt_pointer(%rip)
    jmp syscall_loop
.endif
case_loop:
    mov $record, %edi
    mov %r12, (%rdi)
    mov $0xc0000100, %ecx
    mov $0x123456, %eax
    xor %edx, %edx
    wrmsr
    inc %ecx
    mov $0x12340000, %eax
    mov $0xffff8000, %edx
    wrmsr
    inc %ecx
    mov $0x11112222, %eax
    xor %edx, %edx
    wrmsr
    mov $0xc0000080, %ecx
    mov $0x500, %eax
    wrmsr
    cmp $18, %r12d
    jae efer_case
    mov %r12d, %eax
    xor %edx, %edx
    mov $6, %ecx
    div %ecx
    lea 0xc0000100(%eax), %ecx
    mov values(,%edx,8), %rax
    jmp write_case
efer_case:
    cmp $26, %r12d
    jae swap_case
    mov $0xc0000080, %ecx
    mov %r12d, %eax
    sub $18, %eax
    mov %eax, %edx
    and $1, %eax
    and $6, %edx
    shl $9, %edx
    or %edx, %eax
    or $0x100, %eax
write_case:
    movq $1, 8(%rdi)
    mov %rcx, 16(%rdi)
    mov %rax, 24(%rdi)
    mov %rax, %rdx
    shr $32, %rdx
    /* Upper EAX/EDX parent halves and ECX's upper half are ignored. */
    movabs $0xdeadbeef00000000, %r8
    or %r8, %rax
    or %r8, %rdx
    or %r8, %rcx
    pushq $0x202
    popfq
    wrmsr
    jmp observe
swap_case:
    movq $2, 8(%rdi)
    movq $0, 16(%rdi)
    movq $0, 24(%rdi)
    pushq $0x202
    popfq
    swapgs
observe:
    pushfq
    pop %rax
    mov %rax, 64(%rdi)
    mov $0xc0000100, %ecx
    rdmsr
    shl $32, %rdx
    or %rdx, %rax
    mov %rax, 32(%rdi)
    inc %ecx
    rdmsr
    shl $32, %rdx
    or %rdx, %rax
    mov %rax, 40(%rdi)
    inc %ecx
    rdmsr
    shl $32, %rdx
    or %rdx, %rax
    mov %rax, 48(%rdi)
    mov $0xc0000080, %ecx
    rdmsr
    shl $32, %rdx
    or %rdx, %rax
    mov %rax, 56(%rdi)
    cli
    cld
    mov $record, %esi
    mov $9, %r8d
print_word:
    lodsq
    mov $16, %ecx
hex_digit:
    rol $4, %rax
    mov %al, %dl
    and $15, %dl
    add $48, %dl
    cmp $58, %dl
    jb emit
    add $39, %dl
emit:
    xchg %al, %dl
    out %al, $0xe9
    xchg %al, %dl
    loop hex_digit
    mov $32, %al
    out %al, $0xe9
    dec %r8d
    jnz print_word
    mov $10, %al
    out %al, $0xe9
    inc %r12d
.ifdef MISC_CASES
    cmp $9, %r12d
    jb misc_loop
.else
.ifdef SYSCALL_CASES
    cmp $288, %r12d
    jb syscall_loop
.else
    cmp $32, %r12d
    jb case_loop
.endif
.endif
    mov $0x10, %eax
    out %eax, $0xf4
    hlt
.ifdef SYSCALL_CASES
syscall_loop:
    mov $record,%edi
    mov %r12,(%rdi)
    movq $1,8(%rdi)
    movq $0,72(%rdi)
    movq $0,80(%rdi)
    mov $0xc0000081,%ecx
    xor %eax,%eax
    xor %edx,%edx
    mov $4,%r9d
syscall_reset:
    wrmsr
    inc %ecx
    dec %r9d
    jnz syscall_reset
    mov %r12d,%eax
    xor %edx,%edx
    mov $72,%ecx
    div %ecx
    lea 0xc0000081(%eax),%ecx
    mov %rcx,16(%rdi)
    cmp $64,%edx
    jae syscall_boundary
    mov %ecx,%r9d
    mov %edx,%ecx
    mov $1,%eax
    shl %cl,%rax
    mov %r9d,%ecx
    jmp syscall_write
syscall_boundary:
    sub $64,%edx
    mov syscall_values(,%edx,8),%rax
syscall_write:
    mov %rax,24(%rdi)
    mov %rax,%rdx
    shr $32,%rdx
    movabs $0xdeadbeef00000000,%r8
    or %r8,%rax
    or %r8,%rdx
    or %r8,%rcx
    pushq $0x202
    popfq
    pushfq
    popq 88(%rdi)
    wrmsr
syscall_continue:
    pushfq
    popq 64(%rdi)
    mov $0xc0000081,%ecx
    lea 32(%rdi),%r10
    mov $4,%r9d
syscall_capture:
    rdmsr
    shl $32,%rdx
    or %rdx,%rax
    mov %rax,(%r10)
    inc %ecx
    add $8,%r10
    dec %r9d
    jnz syscall_capture
    cli
    cld
    mov $record,%esi
    mov $12,%r8d
    jmp print_word
syscall_gp:
    push %rax
    movq $13,record+72(%rip)
    mov 8(%rsp),%rax
    mov %rax,record+80(%rip)
    lea syscall_continue(%rip),%rax
    mov %rax,16(%rsp)
    pop %rax
    add $8,%rsp
    iretq
.endif
.ifdef MISC_CASES
misc_loop:
    mov $record, %edi
    mov %r12, (%rdi)
    movq $0, 8(%rdi)
    movq $0x1a0, 16(%rdi)
    mov $0x1a0, %ecx
    test %r12d, %r12d
    jz misc_read
    mov %r12d, %eax
    dec %eax
    mov %eax, %edx
    mov %eax, %r8d
    and $1, %eax
    and $2, %edx
    shl $21, %edx
    or %edx, %eax
    and $4, %r8d
    mov %r8d, %edx
    movq $1, 8(%rdi)
    mov %rdx, %r8
    shl $32, %r8
    or %rax, %r8
    mov %r8, 24(%rdi)
    pushq $0x202
    popfq
    wrmsr
    jmp misc_capture
misc_read:
    pushq $0x202
    popfq
misc_capture:
    pushfq
    pop %rax
    mov %rax, 64(%rdi)
    rdmsr
    shl $32, %rdx
    or %rdx, %rax
    mov %rax, 32(%rdi)
    test %r12d, %r12d
    jnz misc_cpuid
    mov %rax, 24(%rdi)
misc_cpuid:
    mov $0xc0000080, %ecx
    rdmsr
    shl $32, %rdx
    or %rdx, %rax
    mov %rax, 40(%rdi)
    xor %eax, %eax
    cpuid
    mov %rax, 48(%rdi)
    mov $0x80000001, %eax
    cpuid
    mov %rdx, 56(%rdi)
    cld
    mov $record, %esi
    mov $9, %r8d
    jmp print_word
.endif
.section .rodata,"a"
.balign 8
gdt:
    .quad 0, 0x00af9b000000ffff, 0x00cf93000000ffff
gdt_pointer:
    .word 23
    .long gdt
values:
    .quad 0, 1, 0x7fffffffffff, 0xffff800000000000, -1, 0x1234567890
syscall_values:
    .quad 0,1,0x7fffffffffff,0x800000000000,0xffff7fffffffffff,0xffff800000000000,-1,0x0023001000000000
syscall_idt_pointer:
    .word 4095
    .long syscall_idt,0
.section .bss,"aw",@nobits
.balign 4096
pml4: .skip 4096
pdpt: .skip 4096
pd: .skip 4096
record: .skip 96
syscall_idt: .skip 4096
.balign 16
stack: .skip 8192
stack_end:
.section .note.GNU-stack,"",@progbits
