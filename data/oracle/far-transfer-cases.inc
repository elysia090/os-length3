/* Independent far-control fixture; the parent owns boot/GDT/TSS/IDT setup. */
.set gp_handler,far_gp
.set np_handler,far_np
.set ss_handler,far_ss
.set user_handler,far_land
    lea far_land(%rip),%rsi
    mov $idt+128*16,%edi
    call far_gate
    movb $0xee,idt+128*16+5(%rip)
    lea far_gp(%rip),%rsi
    mov $idt+13*16,%edi
    call far_gate
    lea far_np(%rip),%rsi
    mov $idt+11*16,%edi
    call far_gate
    lea far_ss(%rip),%rsi
    mov $idt+12*16,%edi
    call far_gate
    lea far_pf(%rip),%rsi
    mov $idt+14*16,%edi
    call far_gate
    movq $0xa200,tss+36(%rip)
    xor %r12d,%r12d
far_case:
    mov $0xa100,%esp
    lea far_record(%rip),%rdi
    xor %eax,%eax
    mov $34,%ecx
    rep stosq
    mov %r12,far_record(%rip)
    mov %r12d,%eax
    and $7,%eax
    mov %rax,far_record+40(%rip)
    mov %r12d,%eax
    shr $3,%eax
    and $1,%eax
    mov %rax,far_record+16(%rip)
    mov %r12d,%eax
    shr $4,%eax
    and $1,%eax
    mov %rax,far_record+24(%rip)
    mov %r12d,%eax
    shr $5,%eax
    and $1,%eax
    imul $3,%eax,%eax
    mov %rax,far_record+32(%rip)
    mov %r12d,%ecx
    cmp $192,%ecx
    jb 30f
    sub $192,%ecx
30:
    shr $6,%ecx
    mov $2,%eax
    shl %cl,%eax
    mov %rax,far_record+8(%rip)
    mov $0x7100,%eax
    cmpq $5,far_record+40(%rip)
    jne 1f
    mov $0x800000007100,%rax
1:  mov %rax,far_record+48(%rip)
    mov $56,%eax
    cmpq $0,far_record+24(%rip)
    je 2f
    mov $64,%eax
2:  cmpq $1,far_record+40(%rip)
    jne 3f
    xor %eax,%eax
3:  or far_record+32(%rip),%rax
    mov %rax,far_record+56(%rip)
    mov $0x9d08,%eax
    cmpq $7,far_record+40(%rip)
    jne 4f
    cmpq $0,far_record+16(%rip)
    je 4f
    mov $0x300100,%eax
    cmp $192,%r12d
    jb 31f
    mov $0x400008,%eax
31:
4:  mov %rax,far_record+72(%rip)
    mov $0x9f08,%eax
    cmpq $7,far_record+40(%rip)
    jne 5f
    cmpq $0,far_record+16(%rip)
    je 5f
    mov $0x300100,%eax
5:  mov %rax,tss+4(%rip)
    mov %rax,far_record+128(%rip)
    mov $8,%eax
    mov $16,%edx
    cmpq $0,far_record+32(%rip)
    je 6f
    mov $27,%eax
    mov $35,%edx
6:  mov %rax,far_record+80(%rip)
    mov %rdx,far_record+88(%rip)
    movq $0x8d7,far_record+96(%rip)
    mov $0x00af9a000000ffff,%rax
    cmpq $0,far_record+24(%rip)
    jne 7f
    mov far_record+32(%rip),%rdx
    shl $45,%rdx
    or %rdx,%rax
7:  cmp $192,%r12d
    jb 32f
    btr $45,%rax
    btr $46,%rax
    bts $42,%rax
32: cmpq $2,far_record+40(%rip)
    jne 8f
    cmpq $0,far_record+24(%rip)
    jne 8f
    btr $47,%rax
8:  cmpq $3,far_record+40(%rip)
    jne 9f
    and $-2049,%rax
9:  cmpq $4,far_record+40(%rip)
    jne 10f
    mov $0x00affa000000ffff,%rax
    cmpq $3,far_record+32(%rip)
    jne 10f
    mov $0x00af9a000000ffff,%rax
10: mov %rax,gdt+56(%rip)
    mov %rax,far_record+104(%rip)
    mov $0x0000ec0000387100,%rax
    cmpq $2,far_record+40(%rip)
    jne 11f
    btr $47,%rax
11: cmpq $4,far_record+40(%rip)
    jne 12f
    cmpq $3,far_record+32(%rip)
    jne 12f
    btr $45,%rax
    btr $46,%rax
12: mov %rax,gdt+64(%rip)
    mov %rax,far_record+112(%rip)
    xor %eax,%eax
    cmpq $5,far_record+40(%rip)
    jne 13f
    mov $0x8000,%eax
13: mov %rax,gdt+72(%rip)
    mov %rax,far_record+120(%rip)
    mov $0xa5a5a5a5a5a5a5a5,%rax
    mov %rax,0x9ce8
    mov %rax,0x9cf0
    mov %rax,0x9cf8
    mov %rax,0x9d00
    mov %rax,0x9ee8
    mov %rax,0x9ef0
    mov %rax,0x9ef8
    mov %rax,0x9f00
    movq $0x200087,pd+16(%rip)
    mov %rax,0x400000
    movw $0x80cd,0x7100
    movw $0x0b0f,0x7102
    mov $0x7000,%edi
    cmpq $2,far_record+8(%rip)
    jne 14f
    movb $0x66,(%rdi)
    inc %edi
14: cmpq $8,far_record+8(%rip)
    jne 15f
    movb $0x48,(%rdi)
    inc %edi
15: movb $0xff,(%rdi)
    inc %edi
    movb $0x2d,(%rdi)
    cmpq $0,far_record+16(%rip)
    je 16f
    movb $0x1d,(%rdi)
16: inc %edi
    lea 4(%rdi),%edx
    mov %rdx,far_record+64(%rip)
    mov $0x7200,%eax
    cmpq $6,far_record+40(%rip)
    jne 17f
    mov $0x300000,%eax
17: sub %edx,%eax
    mov %eax,(%rdi)
    mov far_record+48(%rip),%rax
    mov %rax,0x7200
    mov far_record+8(%rip),%ecx
    mov far_record+56(%rip),%rax
    mov %ax,0x7200(%rcx)
    cmpq $0,far_record+32(%rip)
    je far_ring0
    pushq $35
    pushq far_record+72(%rip)
    pushq $0x8d7
    pushq $27
    pushq $0x7000
    iretq
far_ring0:
    pushq $0x8d7
    popfq
    mov far_record+72(%rip),%rsp
    jmp 0x7000
far_land:
    pushq $0
    pushq $0
    jmp far_collect
far_gp: pushq $13
    jmp far_collect
far_np: pushq $11
    jmp far_collect
far_ss: pushq $12
    jmp far_collect
far_pf: pushq $14
far_collect:
    mov (%rsp),%rax
    mov %rax,far_record+136(%rip)
    mov 8(%rsp),%rax
    mov %rax,far_record+144(%rip)
    mov 16(%rsp),%rax
    cmpq $0,(%rsp)
    jne 18f
    sub $2,%rax
18: mov %rax,far_record+152(%rip)
    mov 40(%rsp),%rax
    mov %rax,far_record+160(%rip)
    mov 24(%rsp),%rax
    mov %rax,far_record+168(%rip)
    mov 48(%rsp),%rax
    mov %rax,far_record+176(%rip)
    mov 32(%rsp),%rax
    mov %rax,far_record+184(%rip)
    mov gdt+56(%rip),%rax
    mov %rax,far_record+192(%rip)
    lea far_resume(%rip),%rax
    mov %rax,16(%rsp)
    movq $8,24(%rsp)
    movq $2,32(%rsp)
    movq $0xa100,40(%rsp)
    movq $16,48(%rsp)
    add $16,%rsp
    iretq
far_resume:
    mov 0x9ce8,%rax
    mov %rax,far_record+200(%rip)
    mov 0x9cf0,%rax
    mov %rax,far_record+208(%rip)
    mov 0x9cf8,%rax
    mov %rax,far_record+216(%rip)
    mov 0x9d00,%rax
    mov %rax,far_record+224(%rip)
    mov 0x9ee8,%rax
    mov %rax,far_record+232(%rip)
    mov 0x9ef0,%rax
    mov %rax,far_record+240(%rip)
    mov 0x9ef8,%rax
    mov %rax,far_record+248(%rip)
    mov 0x9f00,%rax
    mov %rax,far_record+256(%rip)
    mov 0x400000,%rax
    mov %rax,far_record+264(%rip)
    lea far_record(%rip),%rsi
    mov $34,%r15d
far_print:
    mov (%rsi),%rax
    call hex
    mov $32,%al
    out %al,$0xe9
    add $8,%rsi
    dec %r15d
    jnz far_print
    mov $10,%al
    out %al,$0xe9
    inc %r12d
    cmp $384,%r12d
    jb far_case
    mov $0x10,%eax
    out %eax,$0xf4
    hlt
far_gate:
    mov %si,(%rdi)
    movw $8,2(%rdi)
    movb $1,4(%rdi)
    movb $0x8e,5(%rdi)
    mov %esi,%eax
    shr $16,%eax
    mov %ax,6(%rdi)
    movq $0,8(%rdi)
    ret
.pushsection .bss,"aw",@nobits
.balign 16
far_record: .skip 272
.popsection
