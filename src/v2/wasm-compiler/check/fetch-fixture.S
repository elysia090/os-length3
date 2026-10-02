/* Private planning fixture: do not execute the padding. */
.text
.zero 4094
.globl _start
.type _start,@function
_start:
    cld
    movabs $0x123456789abcdef0,%rax
    cld
    ret
.size _start,.-_start
.section .note.GNU-stack,"",@progbits
