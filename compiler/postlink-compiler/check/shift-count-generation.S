/* The shift consumes the CL computed from the current input, not the entry
 * CL.  A value publication must not move before its count publication. */
.bss
.balign 16
object:
    .skip 64

.text
.globl _start
.type _start, @function
_start:
    lea object(%rip), %rdi
    movb $4, 5(%rdi)
    movb $8, 0x39(%rdi)
    xor %ecx, %ecx
    call alignment_bits
    cmp $16, %eax
    setne %dil
    movzbl %dil, %edi
    mov $60, %eax
    syscall

.type alignment_bits, @function
alignment_bits:
    movzbl 0x39(%rdi), %esi
    xor %edx, %edx
    mov %esi, %eax
    and $0x3f, %eax
    lea -1(%rax), %ecx
    mov $1, %eax
    shl %cl, %eax
    and $0x3f, %esi
    cmovne %eax, %edx
    testb $4, 5(%rdi)
    jne aligned
    xor %eax, %eax
    ret
aligned:
    mov %edx, %eax
    shr $3, %eax
    ret

.balign 16
.rept 4096
    nop
.endr
