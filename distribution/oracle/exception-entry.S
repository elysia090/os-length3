/* A system-oracle fixture only, never a guest execution backend.
 * QEMU's Multiboot loader enters the 32-bit stub. The tested instructions
 * then run at CPL0 in long mode, with a real IDT and hardware-format frames. */
.section .multiboot,"a"
.balign 4
.long 0x1badb002, 0, -0x1badb002
.section .text,"ax"
.code32
.global _start
_start:
    cli
    mov $0xff, %al
    out %al, $0x21
    out %al, $0xa1
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
    mov $stack_end, %esp
    lidt idt_pointer(%rip)
    /* All four tested vectors use a shared handler, but differ in the
     * architectural presence of an error code and saved RIP/RF. */
    xor %r12d, %r12d
case_loop:
    mov %r12d, %eax
    shr $4, %eax
    and $1, %eax
    add $0x8e, %eax
    mov $idt, %edi
    mov $handler, %esi
    mov $256, %ecx
gate_loop:
    mov %si, (%rdi)
    movw $8, 2(%rdi)
    movb $0, 4(%rdi)
    mov %al, 5(%rdi)
    mov %esi, %edx
    shr $16, %edx
    mov %dx, 6(%rdi)
    movq $0, 8(%rdi)
    add $16, %rdi
    loop gate_loop
    movq $0, pd+16(%rip)
    mov %cr3, %rax
    mov %rax, %cr3
    mov $0xabcdef, %eax
    mov %rax, %cr2
    mov $record, %edi
    mov %r12, (%rdi)
    mov $stack_end, %esp
    mov %r12d, %eax
    and $15, %eax
    sub %rax, %rsp
    mov %rsp, 8(%rdi)
    mov $2, %eax
    test $8, %r12d
    jz flags_ready
    mov $0x603, %eax
flags_ready:
    push %rax
    popfq
    pushfq
    pop %rax
    mov %rax, 16(%rdi)
    /* Branching here changes flags; restore immediately before the cut. */
    mov %r12d, %eax
    shr $5, %eax
    cmp $0, %eax
    je page_fault
    cmp $1, %eax
    je invalid_opcode
    cmp $2, %eax
    je general_protection
    pushq 16(%rdi)
    popfq
breakpoint:
    int3
    jmp resumed
page_fault:
    pushq 16(%rdi)
    popfq
faulting_store:
    movb $0x5a, 0x400000
    jmp resumed
invalid_opcode:
    pushq 16(%rdi)
    popfq
faulting_ud:
    ud2
    jmp resumed
general_protection:
    movabs $0x800000000000, %rax
    pushq 16(%rdi)
    popfq
faulting_gp:
    movb (%rax), %al
resumed:
    pushfq
    pop %rax
    mov %rax, record+104(%rip)
    mov %rsp, record+112(%rip)
    cli
    cld
    mov $record, %esi
    mov $15, %r8d
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
    cmp $128, %r12d
    jb case_loop
    mov $0x10, %eax
    out %eax, $0xf4
    hlt
handler:
    /* Capture before the handler changes flags or RSP. Every scratch
     * register used here is restored; r12 identifies the oracle case. */
    push %rax
    push %rcx
    push %rsi
    push %rdi
    pushfq
    pop %rax
    mov %rax, record+32(%rip)
    lea 32(%rsp), %rsi
    mov %rsi, record+24(%rip)
    mov $record+48, %edi
    mov $6, %ecx
    cld
    rep movsq
    mov %cr2, %rax
    mov %rax, record+96(%rip)
    mov %r12d, %eax
    shr $5, %eax
    mov %rax, record+40(%rip)
    cmp $0, %eax
    je handle_page
    cmp $1, %eax
    je handle_ud
    cmp $2, %eax
    je handle_gp
    jmp return_trap
handle_page:
    movq $0x400083, pd+16(%rip)
    jmp return_fault
handle_ud:
    addq $2, 32(%rsp)
    jmp return_trap
handle_gp:
    addq $2, 40(%rsp)
return_fault:
    pop %rdi
    pop %rsi
    pop %rcx
    pop %rax
    add $8, %rsp
    iretq
return_trap:
    pop %rdi
    pop %rsi
    pop %rcx
    pop %rax
    iretq
.section .rodata,"a"
.balign 8
gdt:
    .quad 0, 0x00af9b000000ffff, 0x00cf93000000ffff
gdt_pointer:
    .word 23
    .long gdt
idt_pointer:
    .word 4095
    .long idt, 0
.section .bss,"aw",@nobits
.balign 4096
pml4: .skip 4096
pdpt: .skip 4096
pd: .skip 4096
idt: .skip 4096
record: .skip 128
.balign 16
stack: .skip 8192
stack_end:
.section .note.GNU-stack,"",@progbits
