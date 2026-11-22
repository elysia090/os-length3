// Ordinary string copies and fills for the inline CPU/VM test. No app entry.
.global strings
.text
strings:
    cmp $1, %r8d
    je .Lback_byte
    cmp $2, %r8d
    je .Lword
    cmp $3, %r8d
    je .Lback_dword
    cmp $4, %r8d
    je .Lqword
    cmp $5, %r8d
    je .Lfill_byte
    cmp $6, %r8d
    je .Lfill_word
    cmp $7, %r8d
    je .Lfill_dword
    cmp $8, %r8d
    je .Lfill_qword
    cmp $9, %r8d
    je .Lsingle_copy
    cmp $10, %r8d
    je .Lsingle_fill
    cld
    stc
    rep movsb
    jmp .Ldone
.Lback_byte:
    std
    stc
    jmp .Lback_repeat
.Lback_repeat:
    rep movsb
    jmp .Ldone
.Lword:
    cld
    stc
    rep movsw
    jmp .Ldone
.Lback_dword:
    std
    stc
    rep movsl
    jmp .Ldone
.Lqword:
    cld
    stc
    rep movsq
    jmp .Ldone
.Lfill_byte:
    cld
    stc
    rep stosb
    jmp .Ldone
.Lfill_word:
    std
    stc
    rep stosw
    jmp .Ldone
.Lfill_dword:
    cld
    stc
    rep stosl
    jmp .Ldone
.Lfill_qword:
    std
    stc
    rep stosq
    jmp .Ldone
.Lsingle_copy:
    cld
    stc
    movsq
    jmp .Ldone
.Lsingle_fill:
    std
    stc
    stosb
.Ldone:
    movq %rcx, %rdx
    pushfq
    popq %r10
    movl $231, %eax
    syscall
    hlt
.section .note.GNU-stack,"",@progbits
