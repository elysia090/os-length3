.text
.global _start
.type _start,@function
_start:
#if XLAT_PREFIX
    .byte XLAT_PREFIX
#endif
#if XLAT_ADDRESS32
    .byte 0x67
#endif
    .byte 0xd7
    pushfq
    ret
.size _start,.-_start
.rept 4096
    nop
.endr
.section .note.GNU-stack,"",@progbits
