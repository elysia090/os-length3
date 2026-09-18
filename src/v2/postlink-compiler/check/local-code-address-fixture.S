.section .text
.globl _start
.type _start, @function
_start:
    .rept 16
    nop
    .endr
    /* Keep the product input contract independent from the same-section
     * property under test. */
    lea marker(%rip), %rbx
    cmpb $0x5a, (%rbx)
    jne failed
    /* GAS resolves this same-section local function address completely.  No
     * RELA row remains for the post-link compiler to rediscover it from. */
    lea local_initializer(%rip), %rsi
    call run_once
    mov %eax, %edi
    mov $60, %eax
    syscall
    ud2
failed:
    mov $1, %edi
    mov $60, %eax
    syscall
    ud2
.size _start, .-_start

.type run_once, @function
run_once:
    jmp *%rsi
.size run_once, .-run_once

.type local_initializer, @function
local_initializer:
    mov $42, %eax
    ret
.size local_initializer, .-local_initializer

.section .rodata,"a",@progbits
marker:
    .byte 0x5a

.section .text.unreachable,"ax",@progbits
.fill 16384, 1, 0xcc

.section .note.GNU-stack,"",@progbits
