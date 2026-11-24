// Ordinary static AMD64 execve/vfork caller; compare these exact bytes on Linux and Sods.
.global _start
.text
_start:
  mov 16(%rsp), %r15              // path supplied by the test
  mov 24(%rsp), %r14              // 'e': exec, 'v': vfork/exec
  lea token(%rip), %rdi
  mov $0x80000, %esi              // O_RDONLY | O_CLOEXEC
  xor %edx, %edx
  mov $2, %eax
  syscall
  cmp $3, %rax
  jne bad
  xor %esi, %esi
  mov $2, %eax
  syscall
  cmp $4, %rax
  jne bad
  cmpb $'v', (%r14)
  jne replace
  mov $58, %eax
  syscall
  test %rax, %rax
  jz replace
  js bad
  mov %rax, %rdi
  lea childStatus(%rip), %rsi
  xor %edx, %edx
  xor %r10d, %r10d
  mov $61, %eax
  syscall
  test %rax, %rax
  js bad
  mov childStatus(%rip), %edi
  shr $8, %edi
  jmp end
replace:
  mov %r15, %rdi
  mov %r15, replacementArgv(%rip)
  lea replacementArgv(%rip), %rsi
  lea replacementEnv(%rip), %rdx
  mov $59, %eax
  syscall
  cmp $-2, %rax
  jne bad
  mov $2, %edi                    // An absent file returned errno through execve.
  jmp end
bad:
  mov $90, %edi
end:
  mov $60, %eax
  syscall
.section .rodata
token: .asciz "./token"
message: .asciz "direct"
setting: .asciz "MODE=clean"
.data
replacementArgv: .quad 0, message, 0
replacementEnv: .quad setting, 0
childStatus: .long 0
.section .note.GNU-stack,"",@progbits
