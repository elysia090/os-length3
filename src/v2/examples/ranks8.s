# Exclusive prefix popcount of an 8-bit mask, as x86-64.
#
# Pasting a listing is the other arrow in SPEC 2: QM evaluates it, extracts
# the semantics, and lowers again -- so this is also how you get the wasm32
# form, by choosing that target once the result is in.
#
# Minimizing it returns the same listing: it is already the canonical
# representative, and the search says so rather than moving.
    # qm-input-bits: 8
    .text
    .globl ranks8_qm
    .type ranks8_qm, @function
ranks8_qm:
    movabsq $0x101010101010101, %r11
    pdep %r11, %rdi, %rax
    movabsq $0x101010101010100, %rcx
    imulq %rax, %rcx
    movq %rcx, %rax
    ret
    .size ranks8_qm, .-ranks8_qm
    .section .note.GNU-stack,"",@progbits
