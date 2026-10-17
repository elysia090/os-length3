/* Sample a stopped x86-64 process without changing its executable state. */
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ptrace.h>
#include <sys/types.h>
#include <sys/user.h>
#include <sys/wait.h>

int main(int argc, char **argv)
{
    if (argc != 2) return 2;
    char *end = NULL;
    errno = 0;
    long value = strtol(argv[1], &end, 10);
    if (errno || !end || *end || value <= 0) return 2;
    pid_t pid = (pid_t)value;
    if (ptrace(PTRACE_ATTACH, pid, NULL, NULL)) {
        perror("ptrace attach");
        return 1;
    }
    int status = 0;
    if (waitpid(pid, &status, 0) != pid || !WIFSTOPPED(status)) {
        perror("waitpid");
        return 1;
    }
    struct user_regs_struct regs;
    int result = 0;
    if (ptrace(PTRACE_GETREGS, pid, NULL, &regs)) {
        perror("ptrace getregs");
        result = 1;
    } else {
        printf("rip=0x%llx rsp=0x%llx rbp=0x%llx "
               "rax=0x%llx rbx=0x%llx rcx=0x%llx rdx=0x%llx "
               "rsi=0x%llx rdi=0x%llx\n",
               (unsigned long long)regs.rip,
               (unsigned long long)regs.rsp,
               (unsigned long long)regs.rbp,
               (unsigned long long)regs.rax,
               (unsigned long long)regs.rbx,
               (unsigned long long)regs.rcx,
               (unsigned long long)regs.rdx,
               (unsigned long long)regs.rsi,
               (unsigned long long)regs.rdi);
    }
    if (ptrace(PTRACE_DETACH, pid, NULL, NULL)) {
        perror("ptrace detach");
        result = 1;
    }
    return result;
}
