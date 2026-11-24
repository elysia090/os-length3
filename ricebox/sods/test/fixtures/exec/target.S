.global _start
.text
_start:
  mov $72, %eax
  mov $3, %edi
  mov $1, %esi                    // F_GETFD
  syscall
  cmp $-9, %rax                   // EBADF: close-on-exec ran.
  jne bad
  mov $72, %eax
  mov $4, %edi
  syscall
  test %rax, %rax                 // Other inherited fd is still open.
  jne bad
  mov (%rsp), %rax
  mov 16(%rsp,%rax,8), %r11       // First environment pointer after argv's NULL.
  cmpb $'M', (%r11)
  jne bad
  mov 16(%rsp), %rsi             // First explicit argument, direct or via shebang.
  xor %edx, %edx
size:
  cmpb $0, (%rsi,%rdx)
  je write
  inc %edx
  jmp size
write:
  mov $1, %eax
  mov $1, %edi
  syscall
  lea newline(%rip), %rsi
  mov $1, %eax
  mov $1, %edx
  syscall
  mov $42, %edi
  jmp end
bad:
  mov $91, %edi
end:
  mov $60, %eax
  syscall
.section .rodata
newline: .ascii "\n"
.section .note.GNU-stack,"",@progbits
