.section .text
.globl _start
.type _start, @function
_start:
    .rept 32
    nop
    .endr
    lea record(%rip), %rbx
    movslq (%rbx), %rax
    lea 2(%rbx,%rax), %rax
    /* Model the external warning handler's continuation, without taking
     * a host #UD. Neither the trap nor its next instruction is an ordinary
     * successor of this program's entry. */
    call *%rax
    cmp $42, %eax
    jne failed
    mov $42, %edi
    jmp finished
failed:
    mov $1, %edi
finished:
    mov $60, %eax
    syscall
    ud2
.size _start, .-_start
.fill 128, 1, 0xcc
.Lwarning:
    ud2
    mov $42, %eax
    ret
.section __bug_table,"aw",@progbits
.balign 4
record:
    .long .Lwarning-.
    .long .Lformat-.
    .long .Lfile-.
    .word 1, 1
.section .rodata
.Lformat:
    .asciz ""
.Lfile:
    .asciz "fixture"
.section .text.unreachable,"ax",@progbits
.fill 16384, 1, 0xcc
.section .note.GNU-stack,"",@progbits
