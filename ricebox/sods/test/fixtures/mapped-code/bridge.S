// CPU-backend fixture, not an ELF interpreter or an application launcher.
.global bridge
.text
bridge:
    mov $39, %eax
    syscall
    add $3, %eax
    jmp *%rdi
.section .note.GNU-stack,"",@progbits
