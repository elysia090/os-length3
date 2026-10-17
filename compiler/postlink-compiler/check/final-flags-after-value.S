/* The equality branch consumes CMP, not the flags from the independent OR.
 * The value publication may be reordered, but a flag-clobbering instruction
 * must not cross the final comparison. */
.intel_syntax noprefix
.global _start
.text
_start:
    mov r15, 1
    mov ebp, 1
    sub rsp, 8
    mov QWORD PTR [rsp], 9
    call zero
    mov rdx, QWORD PTR [rsp]
    or ebp, eax
    sub rdx, 8
    movzx ebp, bpl
    cmp r15, rdx
    je equal
    mov edi, 1
    jmp done
equal:
    mov edi, 42
done:
    mov eax, 60
    syscall
zero:
    xor eax, eax
    ret
.section .note.GNU-stack,"",@progbits
