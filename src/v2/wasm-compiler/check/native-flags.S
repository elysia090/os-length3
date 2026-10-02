.text
.global native_flags
.type native_flags,@function
native_flags:
    pushfq
    pop %r8
    mov %r8,(%rdx)
    cmp $16,%esi
    je .Lword
    push %r8
    popfq
    push %rdi
    popfq
    pushfq
    pop %r9
    mov %r9,8(%rdx)
    pushfq
    pop %rax
    mov %rax,16(%rdx)
    jmp .Lrestore
.Lword:
    push %r8
    popfq
    push %di
    popfw
    pushfq
    pop %r9
    mov %r9,8(%rdx)
    pushfw
    pop %ax
    movzwl %ax,%eax
    mov %rax,16(%rdx)
.Lrestore:
    push %r8
    popfq
    ret
.size native_flags,.-native_flags
.section .note.GNU-stack,"",@progbits
