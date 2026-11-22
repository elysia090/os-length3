// A benign TLS slot in a regular owned mapped Task, with no interpreter.
.global tls
.text
tls:
    mov %rsi, %r12
    call install

    mov $158, %eax
    mov $0x1003, %edi
    lea 32(%r12), %rsi
    syscall
    test %rax, %rax
    jne failed
    lea 16(%r12), %r8
    cmp %r8, 32(%r12)
    jne failed
    movl $0x556677, %fs:4

    // A checked GET across a read-only boundary must not copy a prefix.
    mov $158, %eax
    mov $0x1003, %edi
    mov %r13, %rsi
    syscall
    cmp $-14, %rax
    jne failed

    mov $1, %eax
    mov $1, %edi
    mov %r12, %rsi
    mov $7, %edx
    syscall
    cmp $7, %rax
    jne failed
    mov %fs:4, %r8d
    cmp $0x556677, %r8d
    jne failed

    // Clear a base without dereferencing it, and read it back as a word.
    mov $158, %eax
    mov $0x1002, %edi
    xor %esi, %esi
    syscall
    test %rax, %rax
    jne failed
    mov $158, %eax
    mov $0x1003, %edi
    lea 32(%r12), %rsi
    syscall
    test %rax, %rax
    jne failed
    cmpq $0, 32(%r12)
    jne failed
    mov $42, %edi
    jmp done
install:
    mov $158, %eax
    mov $0x1002, %edi
    lea 16(%r12), %rsi
    cmp %r14, %r14
    syscall
after_install:
    jne failed
    test %rax, %rax
    jne failed
    lea after_install(%rip), %r8
    cmp %r8, %rcx
    jne failed
    mov %fs:0, %r8d
    cmp $0x10203040, %r8d
    jne failed
    ret
failed:
    mov $2, %edi
done:
    mov $231, %eax
    syscall
    jmp tls
.section .note.GNU-stack,"",@progbits
