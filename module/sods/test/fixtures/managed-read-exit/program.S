.global _start
.section .text
_start:
  xor %eax, %eax
  mov $3, %edi
  lea buffer(%rip), %rsi
  mov $4, %edx
  syscall
  cmp $4, %rax
  jne failed
  cmpl $0x64636261, buffer(%rip)
  jne failed
  xor %edi, %edi
  jmp finish
failed:
  mov $1, %edi
finish:
  mov $60, %eax
  syscall
  ud2
.section .bss
.align 8
buffer: .skip 4
.section .note.GNU-stack,"",@progbits
