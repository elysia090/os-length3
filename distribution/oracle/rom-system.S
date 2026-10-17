/* Independent read-only physical-bus oracle, not a product firmware/VM. */
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
    or $32,%eax
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
    mov $0xf0000,%edi
case_loop:
    mov $record,%r15d
    mov %rdi,(%r15)
    mov (%rdi),%rax
    mov %rax,8(%r15)
    not %rax
    mov %rax,(%rdi)
    mov (%rdi),%rax
    mov %rax,16(%r15)
    movabs $0x1122334455667788,%rax
    xchg %rax,(%rdi)
    mov %rax,24(%r15)
    mov (%rdi),%rax
    mov %rax,32(%r15)
    /* Locked read-modify-write also completes against immutable bus storage. */
    lock addq $1,(%rdi)
    mov (%rdi),%rax
    mov %rax,40(%r15)
    mov $record,%esi
    mov $6,%r8d
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
    add $4093,%rdi
    cmp $0xffff8,%rdi
    jbe case_loop
    mov $0x10,%eax
    out %eax,$0xf4
    hlt
.section .rodata,"a"
.balign 8
gdt: .quad 0,0x00af9b000000ffff,0x00cf93000000ffff
gdt_pointer: .word 23
    .long gdt
.section .bss,"aw",@nobits
.balign 4096
pml4: .skip 4096
pdpt: .skip 4096
pd: .skip 4096
record: .skip 48
.balign 16
stack: .skip 8192
stack_end:
.section .note.GNU-stack,"",@progbits
