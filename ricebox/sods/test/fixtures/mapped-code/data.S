// Benign memory operations for the inline CPU backend, not an app entry.
.global data
.text
data:
    cmp $1, %edx
    je .Lvector
    cmp $2, %edx
    je .Lcopy
    cmp $3, %edx
    je .Ltls
    cmp $4, %edx
    je .Laddr32
    movq (%rdi), %rax
    movq %rax, 8(%rsi)
    addq $1, (%rsi)
    call .Lstack
.Lvector:
    movdqu 16(%rdi), %xmm0
    movdqu %xmm0, 16(%rsi)
    jmp .Ldone
.Lcopy:
    movq (%rdi), %rax
    movq %rax, (%rsi)
    dec %ecx
    jne .Lcopy
    jmp .Ldone
.Ltls:
    movq %fs:8(%rdi), %rax
    movq %rax, (%rsi)
    jmp .Ldone
.Laddr32:
    movq 8(%edi), %rax
    movq %rax, (%rsi)
.Ldone:
    mov $42, %edi
    mov $231, %eax
    syscall
    hlt
.Lstack:
    push %rax
    pop %rax
    ret
.section .note.GNU-stack,"",@progbits
