/* The only comparison starts after the preceding complete instruction.
 * An immediate or displacement containing 0x3d is not a CMP definition. */
.text
.globl _start
.type _start,@function
_start:
    lea .Lrows(%rip), %rbp
    mov $2, %eax
#if defined(DISPLACEMENT_COMPARE)
    lea 0x003d0000(%rsp), %rcx
#elif defined(ARITHMETIC_COMPARE)
    add $0x003d0000, %ecx
#else
    mov $0x003d0000, %ecx
#endif
    cmp $3, %eax
    ja .Loutside
    mov %eax, %eax
    movslq (%rbp,%rax,4), %rax
    add %rbp, %rax
    jmp *%rax
.Loutside:
    mov $1, %edi
    jmp .Lexit
.Lcase0:
    mov $11, %edi
    jmp .Lexit
.Lcase1:
    mov $19, %edi
    jmp .Lexit
.Lcase2:
    mov $42, %edi
    jmp .Lexit
.Lcase3:
    mov $31, %edi
.Lexit:
    mov $60, %eax
    syscall
.size _start, .-_start
.section .rodata
.balign 4
.Lrows:
    .long .Lcase0-.Lrows
    .long .Lcase1-.Lrows
    .long .Lcase2-.Lrows
    .long .Lcase3-.Lrows
.section .note.GNU-stack,"",@progbits
