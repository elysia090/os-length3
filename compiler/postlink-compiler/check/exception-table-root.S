.section .text
.globl _start
.type _start, @function
_start:
    .rept 32
    nop
    .endr
    lea datum(%rip), %rdi
    call probe
    cmp $7, %eax
    jne failed
    /* The exception continuation is externally entered, not a normal edge
     * of probe. Resolve the same row-relative fixup coordinate as the guest
     * would, but do not deliberately fault a host process in this fixture. */
    lea record+4(%rip), %rbx
    movslq (%rbx), %rax
    add %rbx, %rax
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
.type probe, @function
probe:
.Laccess:
    mov (%rdi), %eax
    ret
.size probe, .-probe
.fill 128, 1, 0xcc
.Lfixup:
    mov $42, %eax
    ret

/* This allocated ABI publishes both the exact faulting instruction and its
 * external continuation. The third word is an opaque handler binding. */
.section __ex_table,"aM",@progbits,12
.balign 4
record:
    .long .Laccess-.
    .long .Lfixup-.
    .long 1
.section .rodata
datum:
    .long 7
.section .text.unreachable,"ax",@progbits
.fill 16384, 1, 0xcc
.section .note.GNU-stack,"",@progbits
