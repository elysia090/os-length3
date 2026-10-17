/* Independent system oracle only. Real IRETQ leaves CPL0; a hardware INT gate
 * records the resulting user frame. Failed trials start a new fixture case,
 * never an execution fallback for a product guest. */
.ifndef RETURN_BYTES
.equ RETURN_BYTES,8
.endif
.ifndef RETURN_FAR
.equ RETURN_FAR,0
.endif
.ifndef RETURN_DISCARD
.equ RETURN_DISCARD,0
.endif
.macro return_slot q,d,w,offset
.if RETURN_BYTES == 8
    mov \q,\offset(%rsp)
.elseif RETURN_BYTES == 4
    mov \d,\offset(%rsp)
.else
    mov \w,\offset(%rsp)
.endif
.endm
.ifdef FRAME_FAULT_PROFILE
.equ HAVE_PF_HANDLER,1
.endif
.ifdef USER_FAULT_PROFILE
.equ HAVE_PF_HANDLER,1
.endif
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
.ifdef USER_FAULT_PROFILE
    or $2048,%eax
.endif
    wrmsr
    mov %cr0,%eax
    or $0x80000001,%eax
    mov %eax,%cr0
    ljmp $8,$long_start
.code64
long_start:
    /* Low identity-map landing pad makes a 16-bit offset observable too.
     * INT transfers onto the real TSS kernel stack before any user RSP use. */
    movw $0x80cd,0x7000
    movw $0x0b0f,0x7002
    lidt idt_pointer(%rip)
    mov $tss,%eax
    shl $16,%rax
    mov $0x890000000067,%rdx
    or %rdx,%rax
    mov %rax,gdt+40(%rip)
    mov $stack_end,%eax
    mov %rax,tss+4(%rip)
.ifdef FRAME_FAULT_PROFILE
    mov %rax,tss+36(%rip)
.endif
    mov $40,%eax
    ltr %ax
    mov $idt,%edi
    mov $128,%ecx
1:  mov $gp_handler,%esi
    call write_gate
    add $16,%rdi
    loop 1b
    mov $idt+11*16,%edi
    mov $np_handler,%esi
    call write_gate
    mov $idt+12*16,%edi
    mov $ss_handler,%esi
    call write_gate
.ifdef HAVE_PF_HANDLER
    mov $idt+14*16,%edi
    mov $pf_handler,%esi
    call write_gate
.endif
.ifdef FRAME_FAULT_PROFILE
    movb $1,idt+11*16+4(%rip)
    movb $1,idt+12*16+4(%rip)
    movb $1,idt+13*16+4(%rip)
    movb $1,idt+14*16+4(%rip)
.endif
    mov $idt+128*16,%edi
    mov $user_handler,%esi
    call write_gate
    movb $0xee,idt+128*16+5(%rip)
.ifdef far_transfer_oracle
    .include "distribution/oracle/far-transfer-cases.inc"
.else
    xor %r12d,%r12d
case_loop:
    cli
.ifdef FRAME_FAULT_PROFILE
    xor %eax,%eax
    mov %rax,%cr2
    movq $0x200087,pd+8(%rip)
    mov $0x200000,%eax
    invlpg (%rax)
.endif
    mov $stack_end,%esp
    mov $16,%eax
    mov %ax,%ds
    mov %ax,%es
    mov %ax,%ss
    mov %ax,%fs
    mov %ax,%gs
    mov $0xc0000100,%ecx
    mov $0x12345000,%eax
    xor %edx,%edx
    wrmsr
    inc %ecx
    mov $0x56789000,%eax
    wrmsr
    mov %r12d,%r13d
    shr $4,%r13d
    mov $3,%r14d
    cmp $12,%r13d
    jae fault_case
    mov %r13d,%eax
    xor %edx,%edx
    mov $3,%ecx
    div %ecx
    lea 1(%rdx),%r14d
fault_case:
    mov $0xfa,%ebx
    mov $0xf2,%edx
    cmp $12,%r13d
    jae descriptors_ready
    mov %r14d,%ebx
    shl $5,%ebx
    or $0x9a,%ebx
    mov %r14d,%edx
    shl $5,%edx
    or $0x92,%edx
    cmp $3,%r13d
    jb descriptors_ready
    or $1,%ebx
    or $1,%edx
descriptors_ready:
    cmp $12,%r13d
    jne 2f
    and $127,%edx
2:  cmp $13,%r13d
    jne 3f
    and $127,%ebx
3:  cmp $15,%r13d
    jne 4f
    mov $0xba,%ebx
4:  cmp $16,%r13d
    jne 5f
    mov $0xd2,%edx
5:  cmp $17,%r13d
    jne 6f
    mov $0xfb,%edx
6:  mov $0x00af00000000ffff,%rax
    mov %ebx,%ecx
    shl $40,%rcx
    or %rcx,%rax
    mov %rax,gdt+24(%rip)
    mov $0x00cf00000000ffff,%rax
    mov %edx,%ecx
    shl $40,%rcx
    or %rcx,%rax
    mov %rax,gdt+32(%rip)
    mov $record,%edi
    mov %r12,(%rdi)
    mov %r14,8(%rdi)
    mov %rbx,16(%rdi)
    mov %rdx,24(%rdi)
    mov $0x202,%ebx
    cmp $6,%r13d
    jb 7f
    or $0x401,%ebx
7:  mov %rbx,32(%rdi)
    mov $user_stack_end,%eax
    mov %r12d,%edx
    and $15,%edx
    sub %rdx,%rax
    cmp $19,%r13d
    jne 11f
    mov $0x0000800000000000,%rax
11:
    mov %rax,40(%rdi)
    mov $stack_end,%esp
    sub %rdx,%rsp
.ifdef FRAME_FAULT_PROFILE
    cmp $20,%r13d
    jb 13f
    mov $0x200010,%esp
    sub %rdx,%rsp
13:
.endif
    mov %rsp,48(%rdi)
    mov %r14d,%eax
    or $32,%eax
    cmp $14,%r13d
    jne 8f
    mov $3,%eax
8:
.if RETURN_FAR || RETURN_BYTES != 8
    mov %rax,%r8
    mov $24,%eax
    or %r14d,%eax
    mov %rax,%r9
    mov $0x7000,%eax
    cmp $18,%r13d
    jne 21f
.if RETURN_BYTES == 8
    mov $0x0000800000000000,%rax
.endif
21:
.if RETURN_FAR
    sub $(4*RETURN_BYTES+RETURN_DISCARD),%rsp
    return_slot %rax,%eax,%ax,0
    return_slot %r9,%r9d,%r9w,RETURN_BYTES
    mov 40(%rdi),%rax
    return_slot %rax,%eax,%ax,2*RETURN_BYTES+RETURN_DISCARD
    return_slot %r8,%r8d,%r8w,3*RETURN_BYTES+RETURN_DISCARD
.else
    sub $(5*RETURN_BYTES),%rsp
    return_slot %rax,%eax,%ax,0
    return_slot %r9,%r9d,%r9w,RETURN_BYTES
    return_slot %rbx,%ebx,%bx,2*RETURN_BYTES
    mov 40(%rdi),%rax
    return_slot %rax,%eax,%ax,3*RETURN_BYTES
    return_slot %r8,%r8d,%r8w,4*RETURN_BYTES
.endif
.else
    push %rax
    pushq 40(%rdi)
    push %rbx
    mov %r14d,%eax
    or $24,%eax
.ifdef FRAME_FAULT_PROFILE
    cmp $20,%r13d
    jne 14f
    mov $3,%eax
14:
.endif
    push %rax
    mov $user_start,%eax
.ifdef USER_FAULT_PROFILE
    mov $0x300000,%eax
.endif
    cmp $18,%r13d
    jne 12f
    mov $0x0000800000000000,%rax
12:
    push %rax
.endif
    pushq $2
    popfq
.ifdef FRAME_FAULT_PROFILE
    cmp $20,%r13d
    jb 15f
    movq $0,pd+8(%rip)
    mov $0x200000,%eax
    invlpg (%rax)
15:
    pushq $2
    popfq
.endif
iret_trial:
.if RETURN_BYTES == 2
    .byte 0x66
.elseif RETURN_BYTES == 8
    .byte 0x48
.endif
.if RETURN_FAR
.if RETURN_DISCARD
    .byte 0xca
    .word RETURN_DISCARD
.else
    .byte 0xcb
.endif
.else
    .byte 0xcf
.endif
user_start:
    int $128
    ud2
np_handler:
    pushq $11
    jmp recorded
ss_handler:
    pushq $12
    jmp recorded
gp_handler:
    pushq $13
    jmp recorded
.ifdef HAVE_PF_HANDLER
pf_handler:
.ifdef USER_FAULT_PROFILE
    mov $pf_handler,%r11d
.endif
    pushq $14
    jmp recorded
.endif
user_handler:
    pushq $0
    pushq $128
recorded:
.ifdef USER_FAULT_PROFILE
    mov %r11,record+208(%rip)
    pushfq
    pop %rax
    mov %rax,record+200(%rip)
    lea 16(%rsp),%rax
    mov %rax,record+176(%rip)
    mov $0,%eax
    mov %ss,%ax
    mov %rax,record+184(%rip)
    mov %cs,%ax
    mov %rax,record+192(%rip)
.endif
    mov $record,%edi
    mov (%rsp),%rax
    mov %rax,56(%rdi)
    mov 8(%rsp),%rax
    mov %rax,64(%rdi)
    mov 16(%rsp),%rax
    mov %rax,72(%rdi)
    mov 24(%rsp),%rax
    mov %rax,80(%rdi)
    mov 32(%rsp),%rax
    mov %rax,88(%rdi)
    mov 40(%rsp),%rax
    mov %rax,96(%rdi)
    mov 48(%rsp),%rax
    mov %rax,104(%rdi)
    xor %eax,%eax
    mov %ds,%ax
    mov %rax,112(%rdi)
    mov %es,%ax
    mov %rax,120(%rdi)
    mov %fs,%ax
    mov %rax,128(%rdi)
    mov %gs,%ax
    mov %rax,136(%rdi)
    mov $0xc0000100,%ecx
    rdmsr
    mov %eax,144(%rdi)
    inc %ecx
    rdmsr
    mov %eax,152(%rdi)
    movzbl gdt+29(%rip),%eax
    mov %rax,160(%rdi)
    movzbl gdt+37(%rip),%eax
    mov %rax,168(%rdi)
.ifdef FRAME_FAULT_PROFILE
    mov %cr2,%rax
    mov %rax,176(%rdi)
.endif
    mov $stack_end,%esp
    cli
    cld
    mov $record,%esi
    mov $22,%r15d
.ifdef USER_FAULT_PROFILE
    mov $27,%r15d
.endif
.ifdef FRAME_FAULT_PROFILE
    inc %r15d
.endif
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
.ifdef FRAME_FAULT_PROFILE
    cmp $352,%r12d
.else
    cmp $320,%r12d
.endif
    jb case_loop
    mov $0x10,%eax
    out %eax,$0xf4
    hlt
.endif
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
9:  rol $4,%rbx
    mov %bl,%al
    and $15,%al
    cmp $10,%al
    jb 10f
    add $39,%al
10: add $48,%al
    out %al,$0xe9
    loop 9b
    ret
.section .data,"aw"
.balign 8
gdt:
.quad 0,0x00af9b000000ffff,0x00cf93000000ffff
.quad 0x00affb000000ffff,0x00cff3000000ffff,0,0
.ifdef far_transfer_oracle
.quad 0,0,0
.endif
gdt_end:
gdt_pointer:
.word gdt_end-gdt-1
.long gdt
idt_pointer:
.word 129*16-1
.long idt,0
.section .bss,"aw",@nobits
.balign 4096
pml4: .skip 4096
pdpt: .skip 4096
pd: .skip 4096
idt: .skip 129*16
.balign 16
tss: .skip 104
.ifdef USER_FAULT_PROFILE
record: .skip 216
.else
record: .skip 184
.endif
.balign 4096
.skip 8192
user_stack_end:
.skip 8192
stack_end:
.section .note.GNU-stack,"",@progbits
