/* Independent system-mode oracle; never a product execution backend.
 * PIT raises IRQ0 while IF=0. Each tested sequence executes as real x86,
 * then hardware IDT entry supplies the frame before this handler records it. */
.section .multiboot,"a"
.balign 4
.long 0x1badb002, 0, -0x1badb002
.section .text,"ax"
.code32
.global _start
_start:
    cli
    lgdt gdt_pointer
    mov $0x10, %ax
    mov %ax, %ds
    mov %ax, %es
    mov %ax, %ss
    mov $stack_end, %esp
    mov $pdpt, %eax
    or $3, %eax
    mov %eax, pml4
    mov $pd, %eax
    or $3, %eax
    mov %eax, pdpt
    movl $0x83, pd
    mov $pml4, %eax
    mov %eax, %cr3
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
    lidt idt_pointer(%rip)
    xor %r12d, %r12d
case_loop:
    cli
    mov $0xff, %al
    out %al, $0x21
    out %al, $0xa1
    mov $0x11, %al
    out %al, $0x20
    out %al, $0xa0
    mov $0x20, %al
    out %al, $0x21
    mov $0x28, %al
    out %al, $0xa1
    mov $4, %al
    out %al, $0x21
    mov $2, %al
    out %al, $0xa1
    mov $1, %al
    out %al, $0x21
    out %al, $0xa1
    mov $0xff, %al
    out %al, $0xa1
    mov $0xfe, %al
    out %al, $0x21
    mov $handler, %esi
    mov $idt+32*16, %edi
    mov %si, (%rdi)
    movw $8, 2(%rdi)
    movb $0, 4(%rdi)
    mov $0x8e, %eax
    cmp $96, %r12d
    jb gate_ready
    inc %eax
gate_ready:
    mov %al, 5(%rdi)
    mov %esi, %edx
    shr $16, %edx
    mov %dx, 6(%rdi)
    movq $0, 8(%rdi)
    /* Non-periodic countdown creates one pending edge, not arbitrary timing
     * between the tested instructions. Wait until the independent PIC IRR
     * reports it; do not infer an IRQ from an elapsed host delay. */
    mov $0x30, %al
    out %al, $0x43
    mov $64, %al
    out %al, $0x40
    xor %eax, %eax
    out %al, $0x40
    mov $0x0a, %al
    out %al, $0x20
wait_irq:
    in $0x20, %al
    test $1, %al
    jz wait_irq
    mov %r12d, %eax
    xor %edx, %edx
    mov $6, %ecx
    div %ecx
    mov %edx, %r14d
    and $15, %eax
    mov $stack_end, %esp
    sub %rax, %rsp
    mov %r12, record(%rip)
    mov %rsp, record+8(%rip)
    movq $0, record+120(%rip)
    mov $2, %r15d
    test $8, %eax
    jz select_sequence
    mov $0x403, %r15d
select_sequence:
    lea sequences(%rip), %rax
    jmp *(%rax,%r14,8)
.macro sequence_head label
\label:
    mov $16, %eax
    push %r15
    popfq
    mov %r15, record+16(%rip)
    lea 1f(%rip), %r13
.endm
    sequence_head seq0
    sti
    nop
1:  cli
    jmp resumed
    sequence_head seq1
    sti
    sti
1:  cli
    jmp resumed
    sequence_head seq2
    sti
    mov %ax, %ss
1:  cli
    jmp resumed
    sequence_head seq3
    mov %ax, %ss
    sti
1:  cli
    jmp resumed
    sequence_head seq4
    sti
    cli
    nop
    sti
    nop
1:  cli
    jmp resumed
    sequence_head seq5
    sti
    nop
1:  cli
resumed:
    mov %rsp, record+104(%rip)
    pushfq
    popq record+96(%rip)
    mov %r13, record+112(%rip)
    cld
    mov $record, %esi
    mov $16, %r8d
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
    cmp $192, %r12d
    jb case_loop
    mov $0x10, %eax
    out %eax, $0xf4
    hlt
handler:
    push %rax
    push %rcx
    push %rsi
    push %rdi
    pushfq
    popq record+32(%rip)
    lea 32(%rsp), %rsi
    mov %rsi, record+24(%rip)
    mov $record+40, %edi
    mov $5, %ecx
    cld
    rep movsq
    incq record+120(%rip)
    mov $0x20, %al
    out %al, $0x20
    pop %rdi
    pop %rsi
    pop %rcx
    pop %rax
    iretq
.section .rodata,"a"
.balign 8
sequences: .long seq0,0,seq1,0,seq2,0,seq3,0,seq4,0,seq5,0
gdt: .quad 0, 0x00af9b000000ffff, 0x00cf93000000ffff
gdt_pointer: .word 23
    .long gdt
idt_pointer: .word 4095
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
