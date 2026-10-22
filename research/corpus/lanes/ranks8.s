# Exclusive prefix popcount of an 8-bit mask, as x86-64.
#
# The two instructions deposit the mask bits into byte lanes and multiply them
# into exclusive prefix counts.
    # qm-input-bits: 8
    .text
    .globl ranks8_qm
    .type ranks8_qm, @function
ranks8_qm:
    movabsq $0x1010101010101, %r11
    pdep %r11, %rdi, %rdi
    movabsq $0x101010101010100, %r11
    imulq %r11, %rdi
    movq %rdi, %rax
    ret
    .size ranks8_qm, .-ranks8_qm
    .section .note.GNU-stack,"",@progbits
