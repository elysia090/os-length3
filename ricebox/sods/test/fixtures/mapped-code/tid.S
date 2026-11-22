// Register two clear-tid words in a regular owned mapped Task.
.global tid
.text
tid:
    mov %rsi, %r12
    mov $39, %eax
    syscall
    mov %rax, %r15
    lea 16(%r12), %rdi
    call register
    mov %r13, %rdi
    call register

    mov $1, %eax
    mov $1, %edi
    mov %r12, %rsi
    mov $7, %edx
    syscall
    cmp $7, %rax
    jne failed
    mov $42, %edi
    jmp done
register:
    mov $218, %eax
    syscall
    cmp %r15, %rax
    jne failed
    ret
failed:
    mov $2, %edi
done:
    mov $231, %eax
    syscall
    jmp tid
.section .note.GNU-stack,"",@progbits
