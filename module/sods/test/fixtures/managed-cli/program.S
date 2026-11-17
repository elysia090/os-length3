/* Rootless CLI startup contract; no libc. cwd is tested in Rust, not here. */
.global _start
.section .text
.macro match offset, label
  mov \offset(%rsp), %rsi
  lea \label(%rip), %rdi
  call equal
.endm
_start:
  test $15, %rsp
  jnz bad
  cmpq $3, (%rsp)
  jne bad
  match 8, path
  match 16, arg1
  match 24, arg2
  cmpq $0, 32(%rsp)
  jne bad
  match 40, env1
  match 48, env2
  match 56, env3
  match 64, env4
  cmpq $0, 72(%rsp)
  jne bad
  lea 80(%rsp), %rbx
aux:
  mov (%rbx), %rax
  test %rax, %rax
  jz bad
  cmp $31, %rax
  je execfn
  add $16, %rbx
  jmp aux
execfn:
  mov 8(%rbx), %rsi
  lea path(%rip), %rdi
  call equal
  xor %edi, %edi
  jmp finish
equal:
  mov (%rsi), %al
  cmp (%rdi), %al
  jne bad
  inc %rsi
  inc %rdi
  test %al, %al
  jnz equal
  ret
bad:
  mov $1, %edi
finish:
  mov $60, %eax
  syscall
  ud2
.section .rodata
path: .asciz "/bin/program.elf"
arg1: .asciz "a"
arg2: .asciz "b"
env1: .asciz "HOME=/root"
env2: .asciz "PATH=/bin:/usr/bin"
env3: .asciz "LANG=C.UTF-8"
env4: .asciz "TERM=dumb"
.section .note.GNU-stack,"",@progbits
