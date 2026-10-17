    .text
    .globl stage_body
    .type stage_body, @function
stage_body:
    xorl %eax, %eax
#ifdef RELEASE_SHARING_VARIANT
    xorl %ecx, %ecx
#endif
    ret
    .size stage_body, .-stage_body

    .section .note.GNU-stack,"",@progbits
