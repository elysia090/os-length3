/* The complement must survive a bitwise update through a memory barrier.
 * GCC's bitmap_clear_range uses this exact mask shape for a one-word range. */
.data
.balign 8
word:
    .quad -1

.text
.globl _start
.type _start, @function
_start:
    lea word(%rip), %rax
    mov $11, %esi
    mov $33, %edx
    mov $0, %edi
    mov $0x200000000, %rbx
    mov $-2048, %rbp
    mov %esi, %r10d
    sub %edi, %r10d
    shr $6, %r10d
    cmp $128, %edx
    jae fail
    mov %edx, %r9d
    sub %edi, %r9d
    mov %r9d, %edi
    shr $6, %edi
    lea -1(%rbx), %r9
    cmp %r10d, %edi
    jne fail
    and %rbp, %r9
    not %r9
    and %r9, (%rax)
    mov $-8589932545, %rcx
    cmp %rcx, (%rax)
    jne fail
    xor %edi, %edi
    jmp finish
fail:
    mov $1, %edi
finish:
    mov $60, %eax
    syscall

.balign 16
.rept 4096
    nop
.endr
