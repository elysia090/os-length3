// Normal memory syscalls in a CPU/VM test, not a direct interpreter launch.
.global resume
.text
resume:
    call protect
    mov $42, %edi
    jmp done
protect:
    cmp %rdi, %rdi
    mov $10, %eax
    syscall
next:
    jne bad_flags
    test %rax, %rax
    jne bad_rax
    lea next(%rip), %r8
    cmp %r8, %rcx
    jne bad_rcx
    ret
bad_flags:
    mov $1, %edi
    jmp done
bad_rax:
    mov $2, %edi
    jmp done
bad_rcx:
    mov $3, %edi
done:
    mov $231, %eax
    syscall
    hlt
.section .note.GNU-stack,"",@progbits
