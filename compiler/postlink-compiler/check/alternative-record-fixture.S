.section .text
.globl _start
.type _start, @function
_start:
    .rept 32
    nop
    .endr
    lea alt_site(%rip), %rdi
    mov %rdi, %rax
    and $-4096, %rdi
    mov $4096, %esi
    mov $7, %edx
    mov $10, %eax
    syscall
    test %rax, %rax
    jne failed

    lea alt_record(%rip), %rbx
    movslq 0(%rbx), %rdi
    add %rbx, %rdi
    movslq 4(%rbx), %rsi
    lea 4(%rbx,%rsi), %rsi
    movzbl 13(%rbx), %ecx
    rep movsb
    cmpb $0x6a, alt_site(%rip)
    jne failed
    cmpb $0x58, alt_site+2(%rip)
    jne failed
    mov $1, %eax
    call alt_site
    cmp $42, %eax
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

alt_site:
    .fill 3, 1, 0x90
alt_site_end:
    ret

.pushsection .altinstr_replacement,"ax",@progbits
alt_replacement:
    push $42
    pop %rax
alt_replacement_end:
.popsection

.pushsection .altinstructions,"aM",@progbits,14
alt_record:
    .long alt_site - .
    .long alt_replacement - .
    .long 0
    .byte alt_site_end - alt_site
    .byte alt_replacement_end - alt_replacement
.popsection

.section .text.unreachable,"ax",@progbits
.fill 16384, 1, 0xcc

.section .note.GNU-stack,"",@progbits
