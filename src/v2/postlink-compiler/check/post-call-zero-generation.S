/* A zero published after CMOV cannot be read from a caller-saved register
 * before its defining XOR. The callee deliberately changes RDX. */
.text
.globl _start
.type _start, @function
_start:
    mov $7, %ebx
    mov $1, %edx
    call clobber
    test %al, %al
    mov $0, %eax
    cmove %rax, %rbx
    xor %edx, %edx
    call check
    mov $60, %eax
    syscall

.type clobber, @function
clobber:
    mov $0x9b, %edx
    xor %eax, %eax
    ret

.type check, @function
check:
    test %rbx, %rbx
    jne failed
    test %rdx, %rdx
    jne failed
    xor %edi, %edi
    ret
failed:
    mov $1, %edi
    ret

.balign 16
.rept 4096
    nop
.endr
