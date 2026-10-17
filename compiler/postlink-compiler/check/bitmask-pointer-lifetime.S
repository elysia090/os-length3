/* A bit-mask update and pointer increment share a pure block before a load.
 * The mask cannot occupy RAX until the old pointer has been advanced. */
.data
table:
    .byte 0, 0x41, 0x42

.text
.globl _start
.type _start, @function
_start:
    lea table(%rip), %rax
    mov (%rsp), %ecx
    add $11, %ecx
    xor %r13d, %r13d
    jmp mask_pointer_start

.globl mask_pointer_start
mask_pointer_start:
    mov $1, %edx
    add $1, %rax
    shl %cl, %edx
    or %edx, %r13d
    movsbl (%rax), %edx
    mov %edx, %esi
    cmp $0x41, %edx
    jne fail
    cmp $0x1000, %r13d
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
