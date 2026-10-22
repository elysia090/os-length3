.section .text
.globl _start
.type _start, @function
_start:
    /* Keep the product gate independent from the trap-continuation red. */
    .rept 32
    nop
    .endr
    lea action(%rip), %rsi
    mov $5, %edi
    xor %edx, %edx
    mov $8, %r10d
    mov $13, %eax
    syscall
    test %rax, %rax
    jne failed

    call trap_site
    cmpb $1, trapped(%rip)
    jne failed
    cmpb $1, continued(%rip)
    jne failed
    mov $60, %eax
    mov $42, %edi
    syscall
failed:
    mov $60, %eax
    mov $1, %edi
    syscall
    ud2
.size _start, .-_start

/* INT3 reports the address after the instruction.  A materialized function
 * coordinate therefore publishes the finite continuation span even though
 * no ordinary CFG edge leaves the trap itself. */
.type trap_site, @function
trap_site:
    int3
    nop
    nop
    nop
    nop
    movb $1, continued(%rip)
    ret
.size trap_site, .-trap_site

.type trap_handler, @function
trap_handler:
    movb $1, trapped(%rip)
    ret
.size trap_handler, .-trap_handler

.type restorer, @function
restorer:
    mov $15, %eax
    syscall
    ud2
.size restorer, .-restorer

.section .data
.balign 8
action:
    .quad trap_handler
    .quad 0x04000000
    .quad restorer
    .quad 0
trapped:
    .byte 0
continued:
    .byte 0
.balign 8
observed_site:
    .quad trap_site

.section .text.unreachable,"ax",@progbits
.fill 16384, 1, 0xcc

.section .note.GNU-stack,"",@progbits
