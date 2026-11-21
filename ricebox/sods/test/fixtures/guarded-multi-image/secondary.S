.file "secondary.S"
.section .rodata,"a",@progbits
.ascii "SECOND!\n"
.section .text,"ax",@progbits
.globl leaf
.hidden leaf
.type leaf,@function
leaf:
  movabs $0x0a21544c55534552,%rax
  ret
.size leaf,.-leaf
.section .data,"aw",@progbits
.quad 0x01020304050607c3
.section .note.GNU-stack,"",@progbits
