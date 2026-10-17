.section .text
.globl _start
.type _start, @function
_start:
    .rept 32
    nop
    .endr
    mov $1, %eax
    xor %ecx, %ecx
    cpuid
    mov %edx, %r12d
    xor %eax, %eax
    mov $1, %ecx
    call probe
    cmp %r12d, %eax
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
    /* The result uses EDX only, but CPUID must first consume EAX and ECX.
     * No CPUID result may be mistaken for an identity of its input lane. */
    mov $1, %eax
    xor %ecx, %ecx
    cpuid
    mov %edx, %eax
    ret
.size probe, .-probe
.section .text.unreachable,"ax",@progbits
.fill 16384, 1, 0xcc
.section .note.GNU-stack,"",@progbits
