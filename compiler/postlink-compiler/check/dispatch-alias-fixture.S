.section .text,"ax",@progbits

.global _start
.type _start,@function
_start:
    xor %esi, %esi
    call dispatch_alias
    cmp $7, %eax
    jne .Lfailed
    mov $1, %esi
    call dispatch_alias
    cmp $13, %eax
    jne .Lfailed
    mov $2, %esi
    call dispatch_alias
    cmp $22, %eax
    jne .Lfailed
    mov $3, %esi
    call dispatch_alias
    cmp $31, %eax
    jne .Lfailed
    mov $4, %esi
    call dispatch_alias
    cmp $43, %eax
    jne .Lfailed
    mov $60, %eax
    mov $42, %edi
    syscall
.Lfailed:
    mov $60, %eax
    mov $1, %edi
    syscall
.size _start, .-_start

.type dispatch_alias,@function
dispatch_alias:
    push %rbx
    mov %esi, %ebx
    cmp $4, %sil
    ja .Ldefault
    movzbl %bl, %eax
    lea .Ltable(%rip), %rdx
    movslq (%rdx,%rax,4), %rax
    add %rdx, %rax
    jmp *%rax
.p2align 4
.Larm0:
    mov .Lslot0(%rip), %r8
    jmp .Lconsume
.p2align 4
.Larm1:
    mov .Lslot1(%rip), %r8
    jmp .Lconsume
.p2align 4
.Larm2:
    mov .Lslot2(%rip), %r8
    jmp .Lconsume
.p2align 4
.Larm3:
    mov .Lslot3(%rip), %r8
    jmp .Lconsume
.p2align 4
.Larm4:
    mov .Lslot4(%rip), %r8
    jmp .Lconsume
.Ldefault:
    xor %r8d, %r8d
.Lconsume:
    call read_selected
    pop %rbx
    ret
.size dispatch_alias, .-dispatch_alias

.type read_selected,@function
read_selected:
    test %r8, %r8
    je .Lzero
    mov (%r8), %eax
    ret
.Lzero:
    xor %eax, %eax
    ret
.size read_selected, .-read_selected

.section .rodata,"a",@progbits
.balign 4
.Ltable:
    .long .Larm0 - .Ltable
    .long .Larm1 - .Ltable
    .long .Larm2 - .Ltable
    .long .Larm3 - .Ltable
    .long .Larm4 - .Ltable
.balign 8
.Lslot0: .quad .Lvalue0
.Lslot1: .quad .Lvalue1
.Lslot2: .quad .Lvalue2
.Lslot3: .quad .Lvalue3
.Lslot4: .quad .Lvalue4
.Lvalue0: .long 7
.Lvalue1: .long 13
.Lvalue2: .long 22
.Lvalue3: .long 31
.Lvalue4: .long 43

.section .text.unreachable,"ax",@progbits
.fill 4096, 1, 0xcc

.section .note.GNU-stack,"",@progbits
