.global _start
.type _start,@function
.section .text.start,"ax",@progbits
_start:
    nop
    nop
    mov $42, %edi
    mov $60, %eax
    syscall
.size _start, .-_start

/* A final static link resolves an undefined weak function to zero.  This
 * function is a real ELF entry but is unreachable from _start.  Its direct
 * target is complete linked-x86 semantics, not a missing compiler block. */
.weak optional_function
.global unused_weak_call
.type unused_weak_call,@function
.section .text.unused,"ax",@progbits
unused_weak_call:
    call optional_function
    ret
.size unused_weak_call, .-unused_weak_call

.section .note.GNU-stack,"",@progbits

/* Keep the product's smaller-output gate independent of this tiny program. */
.section .debug.fixture,"",@progbits
.zero 4096
