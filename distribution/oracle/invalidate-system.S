/* Independent QEMU TCG system oracle, never a product execution backend. */
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
    or $0xa0,%eax
    mov %eax,%cr4
    mov $0xc0000080,%ecx
    rdmsr
    or $0x100,%eax
    wrmsr
    mov %cr0,%eax
    or $0x80000001,%eax
    mov %eax,%cr0
    ljmp $8,$long_start
.code64
long_start:
    mov $0xc0000100,%ecx
    xor %eax,%eax
    mov $0xffff8000,%edx
    wrmsr
    inc %ecx
    mov $0x12345000,%eax
    xor %edx,%edx
    wrmsr
    xor %r12d,%r12d
case_loop:
    xor %r13d,%r13d
address_loop:
    xor %r14d,%r14d
flags_loop:
    mov $record,%r15d
    mov %r12,(%r15)
    mov $addresses,%esi
    mov (%rsi,%r13,8),%rdi
    mov %rdi,8(%r15)
    imul $17,%r12,%rbx
    mov $instructions,%eax
    add %rax,%rbx
    movabs $0x7fffffffffffffff,%rcx
    mov $2,%eax
    test %r14d,%r14d
    jz flags_ready
    mov $0xad7,%eax
flags_ready:
    push %rax
    popfq
    pushfq
    pop %rax
    mov %rax,16(%r15)
    call *%rbx
    pushfq
    pop %rax
    mov %rax,24(%r15)
    cli
    cld
    mov $record,%esi
    mov $4,%r8d
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
    inc %r14d
    cmp $2,%r14d
    jb flags_loop
    inc %r13d
    cmp $6,%r13d
    jb address_loop
    inc %r12d
    cmp $84,%r12d
    jb case_loop
    mov $0x10,%eax
    out %eax,$0xf4
    hlt
instructions:
.macro instruction rank
    .incbin "invalidate-\rank\().source-page",0,16
    ret
.endm
.irp rank,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83
    instruction \rank
.endr
.section .rodata,"a"
.balign 8
gdt:
    .quad 0,0x00af9b000000ffff,0x00cf93000000ffff
gdt_pointer:
    .word 23
    .long gdt
addresses:
    .quad 0,0x400000,0x800000000000,0xffff7fffffffffff,0xffff800000000000,-1
.section .bss,"aw",@nobits
.balign 4096
pml4: .skip 4096
pdpt: .skip 4096
pd: .skip 4096
record: .skip 32
.balign 16
stack: .skip 8192
stack_end:
.section .note.GNU-stack,"",@progbits
