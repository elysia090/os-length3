.text
.global replay
replay:
    mov $39, %eax
    syscall
    clc
    call .Lamount
    jmp *%rdi
.Lamount:
    adc $11, %eax
    ret

.balign 64
    stc
    call .Lamount
    jmp *%rsi

.balign 64
    mov %eax, %edi
    mov $60, %eax
    syscall
    hlt
.section .note.GNU-stack,"",@progbits
