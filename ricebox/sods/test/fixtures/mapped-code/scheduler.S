// Benign scheduler fixture, assembled as an interpreter-free guest DSO.
.global scheduler
.text
scheduler:
    test %edi, %edi
    jne peer
    mov $48, %ebx
count:
    sub $1, %ebx
    jne count
    mov $1, %eax
    mov $1, %edi
    mov $7, %edx
    cmp %r14, %r14
    syscall
after_write:
    jne failed
    cmp $7, %rax
    jne failed
    lea after_write(%rip), %r8
    cmp %r8, %rcx
    jne failed
    mov $42, %edi
    jmp done
failed:
    mov $2, %edi
    jmp done
peer:
    mov $17, %edi
done:
    mov $231, %eax
    syscall
    jmp scheduler
.section .note.GNU-stack,"",@progbits
