/* Inspect the FINAL PF_X domain, not this source population. Normal linking,
 * post-linking and proof verification may erase, relocate or share code. */
.text
.globl _start
.type _start,@function
_start:
#ifdef IMAGE_SHARED
    jmp image_target
.size _start,.-_start
.section .text.image_target,"ax",@progbits
.hidden image_target
.type image_target,@function
image_target:
#endif
    mov $17,%eax
    ret
#ifdef IMAGE_SHARED
.size image_target,.-image_target
#else
.size _start,.-_start
#endif
.section .note.GNU-stack,"",@progbits
