.section .text
.globl _start
.type _start, @function
_start:
    .rept 32
    nop
    .endr
    mov $0x80000008, %eax
    call probe
    cmp $1, %eax
    jne failed
    mov $42, %edi
    jmp finished
failed:
    mov $1, %edi
finished:
    mov $60, %eax
    syscall
    ud2
.size _start, .-_start
.type probe, @function
probe:
    /* The compare replaces the clear's flags, not the surviving upper lane. */
    mov %eax, %edx
    xor %dx, %dx
    cmp $0x80000000, %edx
    je matched
    xor %eax, %eax
    ret
matched:
    cmp $0x80000008, %eax
    sete %al
    movzbl %al, %eax
    ret
.size probe, .-probe
.section .text.unreachable,"ax",@progbits
.fill 16384, 1, 0xcc
.section .note.GNU-stack,"",@progbits
