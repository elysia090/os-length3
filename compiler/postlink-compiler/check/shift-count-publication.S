/* A live entry CL must be consumed before RCX publishes an unrelated value.
 * The source block computes RSI >>= EDX, then passes a pointer in RCX. */
.section .rodata
marker:
    .byte 1
.bss
.balign 8
object:
    .skip 128

.text
.globl _start
.type _start, @function
_start:
    lea object(%rip), %rdi
    lea marker(%rip), %r12
    mov $24, %esi
    mov $2, %edx
    call shifted_call
    mov $60, %eax
    syscall

.type shifted_call, @function
shifted_call:
    mov %edx, %ecx
    shr %cl, %esi
    mov %r12, %rcx
    movl $12, 0x78(%rdi)
    call check
    ret

.type check, @function
check:
    cmp $6, %esi
    jne failed
    cmp %r12, %rcx
    jne failed
    cmpl $12, 0x78(%rdi)
    jne failed
    xor %edi, %edi
    ret
failed:
    mov $1, %edi
    ret

/* Leave dead bytes so the product's size gate remains independent of this
 * register-lifetime regression. */
.balign 16
.rept 4096
    nop
.endr
