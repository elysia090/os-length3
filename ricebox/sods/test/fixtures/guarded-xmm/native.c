// Independent native CPU controls for the exact GNU ld.so encodings.
// Executed in an ordinary test process, not a replacement interpreter.
#define _GNU_SOURCE
#include <assert.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <signal.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>

void rx_merge(void *, uint64_t, uint64_t);
void rx_clear(void *, uint64_t);
void rx_self(void *, uint64_t);
void rx_scalar(void *, uint64_t);
uint64_t rx_sub_flags(uint64_t);
uint64_t rx_push(uint64_t);

// Wrappers set the operands; all audited instructions are the real encodings.
__asm__(
  ".text\n"
  ".globl rx_merge\nrx_merge:\n"
  "push %rbp\nlea 0x80(%rdi),%rbp\nmov %rdx,%rax\n"
  ".byte 0x66,0x48,0x0f,0x6e,0xd6\n" // MOVQ rsi,xmm2
  ".byte 0x66,0x48,0x0f,0x6e,0xd8\n" // MOVQ rax,xmm3
  ".byte 0x66,0x0f,0x6c,0xd3\n"      // PUNPCKLQDQ xmm3,xmm2
  ".byte 0x0f,0x29,0x55,0x80\npop %rbp\nret\n" // MOVAPS xmm2,-128(rbp)
  ".globl rx_clear\nrx_clear:\n"
  "push %rbp\nlea 0x80(%rdi),%rbp\npcmpeqd %xmm2,%xmm2\n"
  ".byte 0x66,0x48,0x0f,0x6e,0xd6\n"
  ".byte 0x0f,0x29,0x55,0x80\npop %rbp\nret\n"
  ".globl rx_self\nrx_self:\n"
  "push %rbp\nlea 0x80(%rdi),%rbp\n"
  ".byte 0x66,0x48,0x0f,0x6e,0xd6\n"
  ".byte 0x66,0x0f,0x6c,0xd2\n" // separate self-alias variant
  ".byte 0x0f,0x29,0x55,0x80\npop %rbp\nret\n"
  ".globl rx_scalar\nrx_scalar:\n"
  "push %rbp\nlea 0x88(%rdi),%rbp\nmov %rsi,%rdi\n"
  ".byte 0x48,0x89,0xbd,0x78,0xff,0xff,0xff\npop %rbp\nret\n"
  ".globl rx_sub_flags\nrx_sub_flags:\n"
  "mov %rsp,%r11\nmov %rdi,%rsp\n"
  ".byte 0x48,0x81,0xec,0x88,0x0,0x0,0x0\n" // SUB rsp,sign-extended imm32
  "mov %r11,%rsp\npushfq\npop %rax\nret\n"
  ".globl rx_push\nrx_push:\n"
  "push %r15\nmov %rdi,%r15\n.byte 0x41,0x57\npop %rax\npop %r15\nret\n"
);

static const uint64_t lo=UINT64_C(0x1234abcd8765dcb1), hi=UINT64_C(0xfedcba9087654321);
static const uint64_t flags_inputs[]={0,7,0x80,0x88,0x89,UINT64_C(0x8000000000000000),INT64_MAX,UINT64_MAX};
static int denied(unsigned char *base, size_t offset, int mode) {
  const pid_t kid=fork();
  assert(kid>=0);
  if (!kid) {
    const struct rlimit lim={0,0};
    assert(setrlimit(RLIMIT_CORE,&lim)==0);
    if (mode==-1) assert(munmap(base+4096,4096)==0);
    else if(mode!=PROT_READ+PROT_WRITE) assert(mprotect(base+4096,4096,mode)==0);
    rx_merge(base+offset,lo,hi);
    _exit(0);
  }
  int rc;
  assert(waitpid(kid,&rc,0)==kid);
  int say=WIFSIGNALED(rc) && WTERMSIG(rc)==SIGSEGV;
  for(size_t i=0;i<8192;i++) assert(base[i]==0x5a);
  return say;
}

static void print_pair(const char *label, const unsigned char *p) {
  uint64_t q[2];
  memcpy(q,p,16);
  printf("\"%s\": [\"%" PRIx64 "\",\"%" PRIx64 "\"],",label,q[0],q[1]);
}

int main(void) {
  assert(sysconf(_SC_PAGESIZE)==4096);
  unsigned char *page=mmap(NULL,8192,PROT_READ|PROT_WRITE,MAP_SHARED|MAP_ANONYMOUS,-1,0);
  assert(page!=MAP_FAILED);
  printf("{");
  rx_merge(page+4080,lo,hi);
  print_pair("merge",page+4080);
  rx_clear(page,lo);
  print_pair("clear",page);
  rx_self(page,lo);
  print_pair("self",page);
  rx_scalar(page+8,hi);
  print_pair("scalar",page);
  printf("\"push\": \"%" PRIx64 "\",\"flags\":[",rx_push(hi));
  for(size_t i=0;i<sizeof(flags_inputs)/sizeof(flags_inputs[0]);i++)
    printf("%s%" PRIu64,i?",":"",rx_sub_flags(flags_inputs[i])&UINT64_C(0x8d5));
  memset(page,0x5a,8192);
  const int unaligned=denied(page,4088,PROT_READ+PROT_WRITE),
            ro=denied(page,4096,PROT_READ),
            none=denied(page,4096,PROT_NONE),
            gone=denied(page,4096,-1);
  printf("],\"unaligned\":%d,\"readOnly\":%d,\"none\":%d,\"unmapped\":%d}\n",unaligned,ro,none,gone);
  assert(munmap(page,8192)==0);
}
