/* A loop counted in a 16-bit register and closed by a branch on DEC's flags,
 * with live bits above the lane: Rust's formatter pads exactly like this.
 * DEC r13w writes only the low 16 bits and sets ZF; a LEA r13d spelling would
 * set no flags (the loop would follow stale ones) and would rewrite bits
 * 16-63. Exits 42 only when the loop ran five times and the upper bits
 * survived. */
.text
.globl _start
.type _start, @function
_start:
    movabs $0x1234567800000005, %r13
    xor %ebx, %ebx
.Lloop:
    dec %r13w
    je .Ldone
    inc %ebx
    test %ebx, %ebx          /* leaves ZF=0 ... */
    cmp %ebx, %ebx           /* ... then ZF=1, which a LEA spelling would read */
    jmp .Lloop
.Ldone:
    movabs $0x1234567800000000, %rax
    cmp %rax, %r13
    jne .Lbad
    cmp $4, %ebx
    jne .Lbad
    mov $42, %edi
    jmp .Lexit
.Lbad:
    mov $1, %edi
.Lexit:
    mov $60, %eax
    syscall
.size _start, .-_start
.section .note.GNU-stack,"",@progbits
