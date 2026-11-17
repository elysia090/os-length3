# Prepared-path startup: root credentials must come from Rust, not caller aux.
# Freestanding guest: no libc or host execution, only exit syscall.
.global _start
.section .text
_start:
  test $15, %rsp
  jne failed
  cmpq $2, (%rsp)
  jne failed
  mov 8(%rsp), %rsi
  cmpl $0x61696c61, (%rsi)
  jne failed
  cmpw $0x0073, 4(%rsi)
  jne failed
  mov 16(%rsp), %rsi
  cmpw $0xfeff, (%rsi)
  jne failed
  cmpb $0, 2(%rsi)
  jne failed
  cmpq $0, 24(%rsp)
  jne failed
  mov 32(%rsp), %rsi
  cmpl $0x00313d41, (%rsi)
  jne failed
  mov 40(%rsp), %rsi
  cmpl $0x00323d41, (%rsi)
  jne failed
  cmpq $0, 48(%rsp)
  jne failed
  lea 56(%rsp), %rsi
  xor %r8d, %r8d
aux:
  mov (%rsi), %rax
  mov 8(%rsi), %rdx
  add $16, %rsi
  test %rax, %rax
  je done
  cmp $11, %rax
  je uid
  cmp $12, %rax
  je euid
  cmp $13, %rax
  je gid
  cmp $14, %rax
  je egid
  cmp $23, %rax
  je secure
  cmp $31, %rax
  je execfn
  cmp $25, %rax
  je random
  cmp $4, %rax
  je phent
  cmp $9, %rax
  je entry
  jmp aux
uid:
  cmp $0, %rdx
  jne failed
  or $1, %r8d
  jmp aux
euid:
  cmp $0, %rdx
  jne failed
  or $2, %r8d
  jmp aux
gid:
  cmp $0, %rdx
  jne failed
  or $4, %r8d
  jmp aux
egid:
  cmp $0, %rdx
  jne failed
  or $8, %r8d
  jmp aux
secure:
  cmp $0, %rdx
  jne failed
  or $16, %r8d
  jmp aux
execfn:
  movabs $0x6174732f6e69622f, %rax
  cmp %rax, (%rdx)
  jne failed
  cmpl $0x70757472, 8(%rdx)
  jne failed
  cmpb $0, 12(%rdx)
  jne failed
  cmp 8(%rsp), %rdx
  je failed
  or $32, %r8d
  jmp aux
random:
  movabs $0x0707070707070707, %rax
  cmp %rax, (%rdx)
  jne failed
  cmp %rax, 8(%rdx)
  jne failed
  or $64, %r8d
  jmp aux
phent:
  cmp $56, %rdx
  jne failed
  or $128, %r8d
  jmp aux
entry:
  lea _start(%rip), %rax
  cmp %rax, %rdx
  jne failed
  or $256, %r8d
  jmp aux
done:
  cmp $511, %r8d
  jne failed
  xor %edi, %edi
  jmp finish
failed:
  mov $1, %edi
finish:
  mov $60, %eax
  syscall
  ud2
.section .note.GNU-stack,"",@progbits
