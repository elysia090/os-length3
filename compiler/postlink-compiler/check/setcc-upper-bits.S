/* SETcc writes only one byte; a full-width use still needs its zeroing
 * predecessor, even when the compare can be scheduled first. */
.text
.globl _start
.type _start, @function
_start:
    call clobber
    cmp $0x100, %esi
    jne failed
    xor %esi, %esi
    cmp %rdi, %r14
    setne %sil
    cmp $1, %esi
    jne failed
    call clobber
    cmp %rdi, %rsi
    mov $0, %esi
    setne %sil
    cmp $1, %esi
    jne failed
    xor %edi, %edi
    jmp finish
failed:
    mov $1, %edi
finish:
    mov $60, %eax
    syscall

.type clobber, @function
clobber:
    mov $0x100, %esi
    mov $1, %rdi
    mov $2, %r14
    ret

.balign 16
.rept 4096
    nop
.endr
