/* Test-only Linux ptrace observer; never a product execution backend. */
#define _GNU_SOURCE
#include <sys/ptrace.h>
#include <sys/wait.h>
#include <sys/user.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc,char **argv)
{
    if(argc<2)return 2;
    pid_t child=fork();if(child<0)return 2;
    if(!child){if(ptrace(PTRACE_TRACEME,0,0,0)<0)_exit(125);raise(SIGSTOP);execv(argv[1],argv+1);_exit(126);}
    int status=0;if(waitpid(child,&status,0)!=child)return 2;
    if(ptrace(PTRACE_SETOPTIONS,child,0,PTRACE_O_TRACESYSGOOD|PTRACE_O_EXITKILL)<0)return 2;
    unsigned stops=0u;int signal=0,stepping=0,prctl_entry=0;
    while(stops++<65536u){
        if(ptrace(stepping?PTRACE_SINGLESTEP:PTRACE_SYSCALL,child,0,signal)<0||waitpid(child,&status,0)!=child)return 2;
        signal=0;
        if(WIFEXITED(status)){printf("oracle-trace exit=%d\n",WEXITSTATUS(status));return WEXITSTATUS(status);}
        if(WIFSIGNALED(status)){printf("oracle-trace signal=%d\n",WTERMSIG(status));return 128+WTERMSIG(status);}
        if(!WIFSTOPPED(status))continue;
        int s=WSTOPSIG(status);
        if(s==(SIGTRAP|128)||(stepping&&s==SIGTRAP)){struct user_regs_struct r;
            if(ptrace(PTRACE_GETREGS,child,0,&r)<0)return 2;
            printf("oracle-trace %s syscall=%lld rax=%llx rip=%llx rdi=%llx rsi=%llx rdx=%llx flags=%llx code=%lx\n",stepping?"step":"boundary",(long long)r.orig_rax,
                (unsigned long long)r.rax,(unsigned long long)r.rip,(unsigned long long)r.rdi,(unsigned long long)r.rsi,(unsigned long long)r.rdx,(unsigned long long)r.eflags,
                (unsigned long)ptrace(PTRACE_PEEKTEXT,child,(void *)r.rip,0));
            if(!stepping&&r.orig_rax==157u&&r.rdi==16u){if(prctl_entry)stepping=1;else prctl_entry=1;}
        }else if(s!=SIGTRAP){
            if(s==SIGSEGV||s==SIGBUS||s==SIGILL){
                struct user_regs_struct r;siginfo_t info;
                if(ptrace(PTRACE_GETREGS,child,0,&r)<0||ptrace(PTRACE_GETSIGINFO,child,0,&info)<0)return 2;
                printf("oracle-trace fault signal=%d address=%p rip=%llx rsp=%llx rbp=%llx rdi=%llx rsi=%llx rdx=%llx flags=%llx code=%lx\n",
                    s,info.si_addr,(unsigned long long)r.rip,(unsigned long long)r.rsp,(unsigned long long)r.rbp,
                    (unsigned long long)r.rdi,(unsigned long long)r.rsi,(unsigned long long)r.rdx,(unsigned long long)r.eflags,
                    (unsigned long)ptrace(PTRACE_PEEKTEXT,child,(void *)r.rip,0));
                for(unsigned i=0;i<16;++i){errno=0;long word=ptrace(PTRACE_PEEKDATA,child,(void *)(r.rsp+8u*i),0);
                    if(errno)break;
                    printf("oracle-trace stack[%u]=%lx\n",i,(unsigned long)word);}
            }
            signal=s;
        }
    }
    kill(child,SIGKILL);waitpid(child,&status,0);fprintf(stderr,"oracle-trace bounded stops exhausted\n");return 2;
}
