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
    cmp $5, %edx
    je .Llocked
    cmp $6, %edx
    je .Lcompare_exchange
    cmp $7, %edx
    je .Lexchange
    cmp $8, %edx
    je .Lexchange_add
    cmp $9, %edx
    je .Lbit_string
    cmp $10, %edx
    je .Lstack_run
    cmp $11, %edx
    je .Lpush_source
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
    jmp .Ldone
.Llocked:
    lock addl $1, (%rsi)
    jnc .Lbad_result
    jz .Ldone
    jmp .Lbad_result
.Lcompare_exchange:
    mov $4, %eax
    mov $7, %ecx
    lock cmpxchgl %ecx, (%rsi)
    jne .Lcomparison_failed
    cmp $4, %eax
    je .Ldone
    jmp .Lbad_result
.Lcomparison_failed:
    cmp $7, %eax
    je .Ldone
    jmp .Lbad_result
.Lexchange:
    mov $9, %eax
    stc
    xchgl %eax, (%rsi)
    jnc .Lbad_result
    cmp $7, %eax
    je .Ldone
    jmp .Lbad_result
.Lexchange_add:
    mov $1, %r10d
    lock xaddq %r10, (%rsi)
    jnc .Lbad_result
    jnz .Lbad_result
    cmp $-1, %r10
    je .Ldone
    jmp .Lbad_result
.Lbit_string:
    mov $-1, %ecx
    lock btsl %ecx, (%rsi)
    jc .Lbad_result
    lock btsl %ecx, (%rsi)
    jc .Ldone
.Lbad_result:
    xor %edi, %edi
    jmp .Lexit
.Ldone:
    mov $42, %edi
.Lexit:
    mov $231, %eax
    syscall
    hlt
.Lstack:
    push %rax
    push %rbx
    push %rcx
    push %r8
    pop %r8
    pop %rcx
    pop %rbx
    pop %rax
    ret
.Lstack_run:
    push %rdi
    push %rsi
    push %r8
    push %r9
    pop %r9
    pop %r8
    pop %rsi
    pop %rdi
    jmp .Ldone
.Lpush_source:
    pushq (%rdi)
    pop %rax
    jmp .Ldone
.section .note.GNU-stack,"",@progbits
