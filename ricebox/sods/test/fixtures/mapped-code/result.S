// CPU-backend fixture: read a register from another mapped object.
.global result
.text
result:
    add $AMOUNT, %eax
    mov %eax, %edi
    mov $60, %eax
    syscall
    ret
.section .note.GNU-stack,"",@progbits
