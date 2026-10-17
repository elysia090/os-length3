/* Privileged reference observation, not a product execution backend. */
.section .multiboot,"a"
.balign 4
.long 0x1badb002,0,-0x1badb002
.section .text,"ax"
.code32
.global _start
_start:
    cli
    mov $0xff,%al
    out %al,$0x21
    out %al,$0xa1
    lgdt gdt_pointer
    mov $0x10,%ax
    mov %ax,%ds
    mov %ax,%es
    mov %ax,%ss
    mov $stack_end,%esp
    mov $pml4,%eax
    mov %eax,%cr3
    mov $pdpt,%eax
    or $3,%eax
    mov %eax,pml4
    mov $pd,%eax
    or $3,%eax
    mov %eax,pdpt
    movl $0x83,pd
    mov %cr4,%eax
    or $0x20,%eax
    mov %eax,%cr4
    mov $0xc0000080,%ecx
    rdmsr
    or $0x100,%eax
    wrmsr
    mov %cr0,%eax
    or $0x80010001,%eax
    mov %eax,%cr0
    ljmp $8,$long_start
.code64
long_start:
    mov $idt,%edi
    mov $handler,%esi
    mov $256,%ecx
gate_loop:
    mov %si,(%rdi)
    movw $8,2(%rdi)
    movb $0,4(%rdi)
    movb $0x8e,5(%rdi)
    mov %esi,%edx
    shr $16,%edx
    mov %dx,6(%rdi)
    movq $0,8(%rdi)
    add $16,%rdi
    loop gate_loop
    /* Each error-code handler supplies its actual vector. */
    mov $idt,%edi
    mov $np_handler,%esi
    mov %si,11*16(%rdi)
    mov $pf_handler,%esi
    mov %si,14*16(%rdi)
    lidt idt_pointer(%rip)
    xor %r12d,%r12d
case_loop:
    mov $record,%edi
    xor %eax,%eax
    mov $16,%ecx
    rep stosq
    mov $record,%edi
    mov %r12,(%rdi)
    /* row: task, prefix, memory, type, present, RPL. */
    mov %r12d,%eax
    and $3,%eax
    mov %rax,48(%rdi)
    or $24,%eax
    mov %ax,selector_input(%rip)
    mov %rax,88(%rdi)
    mov %r12d,%eax
    shr $2,%eax
    and $1,%eax
    mov %rax,40(%rdi)
    shl $7,%eax
    mov %eax,%edx
    mov %r12d,%eax
    shr $3,%eax
    and $31,%eax
    mov %rax,32(%rdi)
    or %edx,%eax
    shl $8,%eax
    mov %eax,%edx
    mov $0x1234,%eax
    mov %rax,56(%rdi)
    mov %edx,%eax
    shl $32,%rax
    orq 56(%rdi),%rax
    mov %rax,gdt+24(%rip)
    mov %rax,56(%rdi)
    movq $0,gdt+32(%rip)
    mov %r12d,%eax
    shr $8,%eax
    and $1,%eax
    mov %rax,24(%rdi)
    mov %eax,%r13d
    mov %r12d,%eax
    shr $9,%eax
    xor %edx,%edx
    mov $3,%ecx
    div %ecx
    mov %rdx,16(%rdi)
    mov %rax,8(%rdi)
    /* Six exact emitted source forms per selector operation. */
    lea (%rdx,%rdx),%eax
    /* Preserve task stride separately after the LEA. */
    mov 8(%rdi),%rbx
    imul $6,%ebx,%ebx
    add %eax,%ebx
    add %r13d,%ebx
    imul $17,%rbx,%rbx
    mov $instructions,%eax
    add %rax,%rbx
    cmpq $0,record+8(%rip)
    jne previous_tr
    sldt %ax
    jmp previous_ready
previous_tr:
    str %ax
previous_ready:
    movzwq %ax,%rax
    mov %rax,record+80(%rip)
    mov $selector_input,%edi
    movzwl (%rdi),%eax
    pushq $0x8d7
    popfq
    pushfq
    popq record+96(%rip)
    call *%rbx
    pushfq
    popq record+104(%rip)
    cli
    cld
    cmpq $0,record+8(%rip)
    jne read_tr
    sldt %ax
    jmp selector_ready
read_tr:
    str %ax
selector_ready:
    movzwq %ax,%rax
    mov %rax,record+112(%rip)
    mov gdt+24(%rip),%rax
    mov %rax,record+120(%rip)
    mov $record,%esi
    mov $16,%r8d
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
    cmp $3072,%r12d
    jb case_loop
    mov $0x10,%eax
    out %eax,$0xf4
    hlt
handler:
    movq $13,record+64(%rip)
    jmp fault_record
np_handler:
    movq $11,record+64(%rip)
    jmp fault_record
pf_handler:
    movq $14,record+64(%rip)
fault_record:
    push %rax
    mov 8(%rsp),%rax
    mov %rax,record+72(%rip)
    lea 16(%rbx),%rax
    mov %rax,16(%rsp)
    pop %rax
    add $8,%rsp
    iretq
instructions:
.macro instruction rank
    .incbin "segment-\rank\().source-page",0,16
    ret
.endm
instruction 0
instruction 16
instruction 24
instruction 40
instruction 48
instruction 64
instruction 72
instruction 88
instruction 96
instruction 112
instruction 120
instruction 136
.section .rodata,"a"
.balign 8
gdt:
    .quad 0,0x00af9b000000ffff,0x00cf93000000ffff,0,0
gdt_pointer:
    .word 39
    .long gdt
idt_pointer:
    .word 4095
    .long idt,0
.section .bss,"aw",@nobits
.balign 4096
pml4: .skip 4096
pdpt: .skip 4096
pd: .skip 4096
idt: .skip 4096
record: .skip 128
selector_input: .skip 8
.balign 16
stack: .skip 8192
stack_end:
.section .note.GNU-stack,"",@progbits
