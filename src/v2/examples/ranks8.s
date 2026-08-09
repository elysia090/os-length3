# Exclusive prefix popcount of an 8-bit mask, as x86-64.
#
# A listing can be pasted here as readily as C: it is evaluated, minimized and
# lowered again, so this is also how the same function is obtained as wasm32 --
# choose that target once the answer is in.
#
# Minimizing this one returns it unchanged, which is the property worth having:
# it is already the shortest form of what it computes.
    # qm-input-bits: 8
    .text
    .globl ranks8_qm
    .type ranks8_qm, @function
ranks8_qm:
    movabsq $0x101010101010101, %r11
    pdep %r11, %rdi, %rdi
    movabsq $0x101010101010100, %r11
    imulq %r11, %rdi
    movq %rdi, %rax
    ret
    .size ranks8_qm, .-ranks8_qm
    .section .note.GNU-stack,"",@progbits
