/* Independent system observations only. SYSCALL/SYSRET run on the reference
 * CPU, not through any product decoder or Linux syscall implementation. */
.section .multiboot,"a"
.balign 4
.long 0x1badb002,0,-0x1badb002
.section .text,"ax"
.code32
.global _start
_start:
    cli
    mov $255,%al
    out %al,$0x21
    out %al,$0xa1
    lgdt gdt_pointer
    mov $16,%ax
    mov %ax,%ds
    mov %ax,%es
    mov %ax,%ss
    mov $stack_end,%esp
    mov $pdpt,%eax
    or $7,%eax
    mov %eax,pml4
    mov $pd,%eax
    or $7,%eax
    mov %eax,pdpt
    movl $0x87,pd
    mov $pml4,%eax
    mov %eax,%cr3
    mov %cr4,%eax
    or $32,%eax
    mov %eax,%cr4
    mov $0xc0000080,%ecx
    rdmsr
    or $256,%eax
    wrmsr
    mov %cr0,%eax
    or $0x80000001,%eax
    mov %eax,%cr0
    ljmp $8,$long_start
.code64
long_start:
    lidt idt_pointer(%rip)
    mov $tss,%eax
    shl $16,%rax
    mov $0x890000000067,%rdx
    or %rdx,%rax
    mov %rax,gdt+48(%rip)
    mov $stack_end,%eax
    mov %rax,tss+4(%rip)
    mov $48,%eax
    ltr %ax
    mov $idt+6*16,%edi
    mov $ud_handler,%esi
    call write_gate
    mov $idt+13*16,%edi
    mov $gp_handler,%esi
    call write_gate
    mov $idt+128*16,%edi
    mov $return_handler,%esi
    call write_gate
    movb $0xee,idt+128*16+5(%rip)
    mov $0xc0000100,%ecx
    mov $0x12345000,%eax
    xor %edx,%edx
    wrmsr
    inc %ecx
    mov $0x56789000,%eax
    wrmsr
    xor %r12d,%r12d
case_loop:
    cli
    cld
    mov $stack_end,%esp
    mov $record,%edi
    xor %eax,%eax
    mov $32,%ecx
    rep stosq
    mov %r12,record(%rip)
    mov %r12d,%eax
    and $3,%eax
    lea flags(%rip),%rdx
    mov (%rdx,%rax,8),%r13
    mov %r13,record+8(%rip)
    lea masks(%rip),%rdx
    mov (%rdx,%rax,8),%r14
    mov %r14,record+16(%rip)
    mov $0xc0000084,%ecx
    mov %r14d,%eax
    xor %edx,%edx
    wrmsr
    mov $0xc0000081,%ecx
    mov $24,%edx
    mov $8,%eax
    test $16,%r12d
    jz 1f
    mov $64,%eax
1:  mov %r12d,%r8d
    and $3,%r8d
    or %r8d,%eax
    mov %eax,%r8d
    shl $32,%r8
    mov $24,%eax
    shl $48,%rax
    or %rax,%r8
    mov %r8,record+24(%rip)
    mov %r8,%rdx
    shr $32,%rdx
    xor %eax,%eax
    wrmsr
    mov $0xc0000082,%ecx
    mov $syscall_handler,%eax
    xor %edx,%edx
    wrmsr
    mov $0xc0000080,%ecx
    rdmsr
    or $1,%eax
    cmp $48,%r12d
    jb 2f
    and $-2,%eax
2:  wrmsr
    mov %eax,record+208(%rip)
    mov $user_stack_end,%eax
    mov %r12d,%edx
    and $15,%edx
    sub %rdx,%rax
    cmp $32,%r12d
    jae 3f
    test $8,%r12d
    jz 3f
    mov $0x800000000000,%rax
3:  mov %rax,record+32(%rip)
    mov $user_after,%edx
    mov %rdx,record+40(%rip)
    mov $syscall_trial,%edx
    mov %rdx,record+192(%rip)
    mov $sysret_trial,%edx
    mov %rdx,record+200(%rip)
    pushq $35
    push %rax
    push %r13
    pushq $43
    mov $syscall_trial,%eax
    push %rax
    pushq $2
    popfq
    iretq
syscall_trial:
    syscall
user_after:
    int $128
    ud2
syscall_handler:
    mov %rsp,record+72(%rip)
    mov %rcx,record+80(%rip)
    mov %r11,record+88(%rip)
    mov $stack_end,%esp
    pushfq
    pop %rax
    mov %rax,record+64(%rip)
    mov $0,%eax
    mov %cs,%ax
    mov %rax,record+48(%rip)
    mov %ss,%ax
    mov %rax,record+56(%rip)
    mov $user_returned,%ecx
    cmp $32,%r12d
    jb 4f
    mov $0x800000000000,%rcx
4:  mov %rcx,record+96(%rip)
    mov %r13,%r11
    mov $0x8000000000038000,%rax
    or %rax,%r11
    mov %r11,record+104(%rip)
    /* Invalid SYSRET uses a safe kernel stack; successful SYSRET restores
     * the original user RSP, including a noncanonical pointer not accessed. */
    mov %rsp,%r8
    cmp $32,%r12d
    jae 5f
    mov record+32(%rip),%r8
5:  pushq $2
    popfq
    mov %r8,%rsp
sysret_trial:
    sysretq
user_returned:
    int $128
    ud2
ud_handler:
    pushq $0
    pushq $6
    jmp recorded
gp_handler:
    pushq $13
    jmp recorded
return_handler:
    pushq $0
    pushq $128
recorded:
    /* Save flags before any flag-modifying arithmetic. */
    pushfq
    pop %rax
    mov %rax,record+184(%rip)
    mov $0,%eax
    mov %cs,%ax
    mov %rax,record+168(%rip)
    mov %ss,%ax
    mov %rax,record+176(%rip)
    mov $record+112,%edi
    mov $7,%ecx
    mov %rsp,%rsi
    cld
    rep movsq
    mov $stack_end,%esp
    cli
    cld
    mov $0xc0000100,%ecx
    rdmsr
    mov %eax,record+216(%rip)
    inc %ecx
    rdmsr
    mov %eax,record+224(%rip)
    mov $0,%eax
    mov %ds,%ax
    mov %rax,record+232(%rip)
    mov %es,%ax
    mov %rax,record+240(%rip)
    mov $record,%esi
    mov $32,%r15d
print_record:
    mov (%rsi),%rax
    call hex
    mov $32,%al
    out %al,$0xe9
    add $8,%rsi
    dec %r15d
    jnz print_record
    mov $10,%al
    out %al,$0xe9
    inc %r12d
    cmp $64,%r12d
    jb case_loop
    mov $16,%eax
    out %eax,$0xf4
    hlt
write_gate:
    mov %si,(%rdi)
    movw $8,2(%rdi)
    movb $0,4(%rdi)
    movb $0x8e,5(%rdi)
    mov %esi,%eax
    shr $16,%eax
    mov %ax,6(%rdi)
    movq $0,8(%rdi)
    ret
hex:
    mov %rax,%rbx
    mov $16,%ecx
6:  rol $4,%rbx
    mov %ebx,%eax
    and $15,%eax
    add $48,%eax
    cmp $57,%eax
    jbe 7f
    add $39,%eax
7:  out %al,$0xe9
    loop 6b
    ret
.section .rodata,"a"
.balign 8
flags: .quad 2,0x603,0x10002,0x450ed7
masks: .quad 0,0x600,0x3c7dd7,0xffffffff
gdt:
    .quad 0,0x00af9b000000ffff,0x00cf93000000ffff
    .quad 0x00cffb000000ffff,0x00cff3000000ffff,0x00affb000000ffff
    .quad 0,0,0,0
gdt_end:
gdt_pointer: .word gdt_end-gdt-1
    .long gdt,0
idt_pointer: .word 4095
    .long idt,0
.section .bss,"aw",@nobits
.balign 4096
pml4: .skip 4096
pdpt: .skip 4096
pd: .skip 4096
idt: .skip 4096
.balign 16
tss: .skip 104
record: .skip 256
.balign 4096
stack: .skip 4096
stack_end:
user_stack: .skip 4096
user_stack_end:
