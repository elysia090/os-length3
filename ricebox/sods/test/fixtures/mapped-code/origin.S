// Ask the ordinary guest procfs for the executable name, without an interpreter.
.global origin
.text
origin:
    mov %rsi, %r12
    mov %r12, %rdi
    lea 128(%r12), %rsi
    mov $4096, %edx
    mov $89, %eax
    syscall
    test %rax, %rax
    jle failed

    lea 64(%r12), %rdx
    mov $17, %r10d
    mov $267, %eax
    mov $-100, %edi
    mov %r12, %rsi
    syscall
    cmp $17, %rax
    jne failed
    xor %edi, %edi
    jmp done
failed:
    mov $2, %edi
done:
    mov $231, %eax
    syscall
    jmp origin
.section .note.GNU-stack,"",@progbits
