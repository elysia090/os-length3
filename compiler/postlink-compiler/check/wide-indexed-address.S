/* A narrow index wraps before zero extension into a wide effective address.
 * The stack base makes loss of the pointer's high half observable. */
.text
.globl _start
.type _start, @function
_start:
    mov %rsp, %rbp
    mov $17, %ecx
    call indexed_address
    lea 21(%rbp), %rax
    cmp %rax, %rdi
    jne fail

    xor %ecx, %ecx
    call indexed_address
    mov $0x100000004, %rax
    add %rbp, %rax
    cmp %rax, %rdi
    jne fail

    xor %edi, %edi
    jmp finish
fail:
    mov $1, %edi
finish:
    mov $60, %eax
    syscall

.type indexed_address, @function
indexed_address:
    lea -1(%rcx), %edx
    lea 5(%rbp,%rdx), %rdi
    ret

.balign 16
.rept 4096
    nop
.endr
