.global _start
.type _start,@function
.section .text.start,"ax",@progbits
_start:
    xor %eax, %eax
    mov $42, %edi
    call .Loverlap
    mov $60, %eax
    syscall
.size _start, .-_start

.type .Loverlap,@function
.section .text.overlapping_control,"ax",@progbits
.Loverlap:
    /* At this coordinate the bytes decode as JO +1-byte-interior.  The taken
     * coordinate decodes the shared suffix as INC RBX; the ordinary
     * fallthrough decodes RET.  Both are valid linked-x86 futures and must be
     * emitted as separate bodies rather than rejected as overlapping owners. */
    .byte 0x70, 0xff, 0xc3, 0xc3
.size .Loverlap, .-.Loverlap

.section .note.GNU-stack,"",@progbits
