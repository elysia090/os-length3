/* Observe a native program's first synchronous fault without changing it.
 * Optional --break ADDRESS reports register state at that x86-64 address;
 * --watch-on-hit N then follows the Nth hit's [RSI+8] with a hardware
 * watchpoint. --peek-indirect OFFSET WORDS at a breakpoint dumps words from
 * [[RDI]+OFFSET]; --trace-from-hit N steps after that hit. Run linked and
 * optimized ELFs independently to find the first
 * differing write, rather than treating the final fault as the cause. */
#include <errno.h>
#include <stddef.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ptrace.h>
#include <sys/personality.h>
#include <sys/types.h>
#include <sys/user.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    unsigned long long breakpoint = 0;
    unsigned long long watch_on_hit = 0;
    unsigned long long trace_from_hit = 0;
    unsigned long long indirect_offset = 0;
    unsigned long long indirect_words = 0;
    unsigned long long first_entry_begin = 0;
    unsigned long long first_entry_end = 0;
    int step_tail = 0;
    unsigned long long watch_from_start = 0;
    int program = 1;
    if (argc >= 3 && !strcmp(argv[program], "--step-tail")) {
        step_tail = 1;
        program += 1;
    }
    if (argc >= program + 3 && !strcmp(argv[program], "--first-entry")) {
        char *end = NULL;
        first_entry_begin = strtoull(argv[program + 1], &end, 0);
        if (!end || *end || !first_entry_begin) return 2;
        first_entry_end = strtoull(argv[program + 2], &end, 0);
        if (!end || *end || first_entry_end <= first_entry_begin)
            return 2;
        program += 3;
    }
    if (argc >= 3 && !strcmp(argv[program], "--watch")) {
        char *end = NULL;
        watch_from_start = strtoull(argv[program + 1], &end, 0);
        if (!end || *end || !watch_from_start
                || (watch_from_start & 7u)) return 2;
        program += 2;
    }
    if (argc >= program + 2 && !strcmp(argv[program], "--break")) {
        char *end = NULL;
        breakpoint = strtoull(argv[program + 1], &end, 0);
        if (!end || *end || !breakpoint) return 2;
        program += 2;
    }
    if (argc >= program + 3 && !strcmp(argv[program], "--peek-indirect")) {
        char *end = NULL;
        indirect_offset = strtoull(argv[program + 1], &end, 0);
        if (!end || *end || indirect_offset > 4096 || !breakpoint)
            return 2;
        indirect_words = strtoull(argv[program + 2], &end, 0);
        if (!end || *end || !indirect_words || indirect_words > 128)
            return 2;
        program += 3;
    }
    if (argc >= program + 3 && !strcmp(argv[program], "--watch-on-hit")) {
        char *end = NULL;
        watch_on_hit = strtoull(argv[program + 1], &end, 0);
        if (!end || *end || !watch_on_hit || !breakpoint) return 2;
        program += 2;
    }
    if (argc >= program + 3 && !strcmp(argv[program], "--trace-from-hit")) {
        char *end = NULL;
        trace_from_hit = strtoull(argv[program + 1], &end, 0);
        if (!end || *end || !trace_from_hit || !breakpoint) return 2;
        program += 2;
    }
    if (argc <= program) return 2;
    pid_t child = fork();
    if (child < 0) return 2;
    if (!child) {
        int personality_flags = personality(0xffffffffu);
        if (personality_flags == -1
                || personality(personality_flags | ADDR_NO_RANDOMIZE) == -1)
            _exit(127);
        if (ptrace(PTRACE_TRACEME, 0, 0, 0)) _exit(127);
        execv(argv[program], argv + program);
        _exit(127);
    }
    int status = 0;
    if (waitpid(child, &status, 0) != child || !WIFSTOPPED(status))
        return 2;
    unsigned long original_word = 0;
    if (breakpoint) {
        errno = 0;
        original_word = (unsigned long)ptrace(
            PTRACE_PEEKDATA, child, (void *)breakpoint, 0);
        if (errno || ptrace(PTRACE_POKEDATA, child,
                (void *)breakpoint,
                (void *)((original_word & ~0xfful) | 0xccul)))
            return 2;
    }
    int stepping = step_tail || first_entry_begin ? 2 : 0;
    enum { RIP_HISTORY = 128 };
    unsigned long long last_rips[RIP_HISTORY] = {0};
    unsigned long long step_count = 0;
    unsigned long long hits = 0;
    unsigned long long trace_previous_rip = 0;
    unsigned long long watch_address = watch_from_start;
    if (watch_address && (ptrace(PTRACE_POKEUSER, child,
            (void *)offsetof(struct user, u_debugreg[0]),
            (void *)(uintptr_t)watch_address)
        || ptrace(PTRACE_POKEUSER, child,
            (void *)offsetof(struct user, u_debugreg[7]),
            (void *)(uintptr_t)0x90001u))) return 2;
    for (;;) {
        if (ptrace(stepping ? PTRACE_SINGLESTEP : PTRACE_CONT,
                   child, 0, 0)) return 2;
        if (waitpid(child, &status, 0) != child) return 2;
        if (WIFEXITED(status)) {
            fprintf(stderr, "exit=%d\n", WEXITSTATUS(status));
            return WEXITSTATUS(status);
        }
        if (WIFSIGNALED(status)) {
            fprintf(stderr, "signal=%d\n", WTERMSIG(status));
            return 1;
        }
        if (!WIFSTOPPED(status)) return 2;
        int signal = WSTOPSIG(status);
        if (signal == SIGTRAP && (breakpoint || watch_address || step_tail
                                  || first_entry_begin)) {
            struct user_regs_struct regs;
            if (ptrace(PTRACE_GETREGS, child, 0, &regs)) return 2;
            if (stepping == 2) {
                if (first_entry_begin) {
                    if (regs.rip >= first_entry_begin
                            && regs.rip < first_entry_end
                            && (trace_previous_rip < first_entry_begin
                                || trace_previous_rip >= first_entry_end)) {
                        fprintf(stderr, "first-entry previous-rip=0x%llx rip=0x%llx "
                               "rsp=0x%llx rdi=0x%llx rsi=0x%llx "
                               "rbx=0x%llx rbp=0x%llx r14=0x%llx "
                               "r15=0x%llx\n",
                               trace_previous_rip,
                               (unsigned long long)regs.rip,
                               (unsigned long long)regs.rsp,
                               (unsigned long long)regs.rdi,
                               (unsigned long long)regs.rsi,
                               (unsigned long long)regs.rbx,
                               (unsigned long long)regs.rbp,
                               (unsigned long long)regs.r14,
                               (unsigned long long)regs.r15);
                        (void)ptrace(PTRACE_KILL, child, 0, 0);
                        (void)waitpid(child, &status, 0);
                        return 0;
                    }
                    trace_previous_rip = regs.rip;
                    continue;
                }
                if (step_tail) {
                    last_rips[step_count % RIP_HISTORY] = regs.rip;
                    ++step_count;
                    if (step_count % 1000000u == 0u) {
                        fprintf(stderr, "trace steps=%llu rip=0x%llx\n",
                                step_count, (unsigned long long)regs.rip);
                        fflush(stderr);
                    }
                    continue;
                }
                fprintf(stderr, "step previous-rip=0x%llx rip=0x%llx "
                       "rsp=0x%llx rax=0x%llx rdx=0x%llx "
                       "rdi=0x%llx rsi=0x%llx rcx=0x%llx "
                       "rbx=0x%llx r10=0x%llx r12=0x%llx\n",
                       trace_previous_rip,
                       (unsigned long long)regs.rip,
                       (unsigned long long)regs.rsp,
                       (unsigned long long)regs.rax,
                       (unsigned long long)regs.rdx,
                       (unsigned long long)regs.rdi,
                       (unsigned long long)regs.rsi,
                       (unsigned long long)regs.rcx,
                       (unsigned long long)regs.rbx,
                       (unsigned long long)regs.r10,
                       (unsigned long long)regs.r12);
                if (regs.rsp < 0x100000000ull) {
                    fprintf(stderr, "stack-truncated previous-rip=0x%llx "
                           "rip=0x%llx rsp=0x%llx\n",
                           trace_previous_rip,
                           (unsigned long long)regs.rip,
                           (unsigned long long)regs.rsp);
                    fflush(stderr);
                }
                trace_previous_rip = regs.rip;
                continue;
            }
            if (stepping) {
                if (watch_address) {
                    breakpoint = 0;
                } else if (ptrace(PTRACE_POKEDATA, child,
                        (void *)breakpoint,
                        (void *)((original_word & ~0xfful) | 0xccul)))
                    return 2;
                stepping = 0;
                continue;
            }
            if (breakpoint && regs.rip == breakpoint + 1) {
                if (ptrace(PTRACE_POKEDATA, child,
                        (void *)breakpoint, (void *)original_word))
                    return 2;
                regs.rip = breakpoint;
                if (ptrace(PTRACE_SETREGS, child, 0, &regs)) return 2;
                errno = 0;
                unsigned long pointed = (unsigned long)ptrace(
                    PTRACE_PEEKDATA, child, (void *)regs.rdi, 0);
                int bad_pointed = errno;
                errno = 0;
                unsigned long field = (unsigned long)ptrace(
                    PTRACE_PEEKDATA, child, (void *)(regs.rbx + 8), 0);
                int bad_rbx = errno;
                errno = 0;
                unsigned long argument_field = (unsigned long)ptrace(
                    PTRACE_PEEKDATA, child, (void *)(regs.rsi + 8), 0);
                int bad_rsi = errno;
                errno = 0;
                unsigned long align_field = (unsigned long)ptrace(
                    PTRACE_PEEKDATA, child, (void *)regs.rsi, 0);
                int bad_align = errno;
                errno = 0;
                unsigned long saved_align = (unsigned long)ptrace(
                    PTRACE_PEEKDATA, child, (void *)regs.r13, 0);
                int bad_saved_align = errno;
                errno = 0;
                unsigned long base_align = (unsigned long)ptrace(
                    PTRACE_PEEKDATA, child, (void *)regs.rbp, 0);
                int bad_base_align = errno;
                errno = 0;
                unsigned long first_field = (unsigned long)ptrace(
                    PTRACE_PEEKDATA, child, (void *)(regs.rdi + 0x48), 0);
                int bad_first_field = errno;
                errno = 0;
                unsigned long return_address = (unsigned long)ptrace(
                    PTRACE_PEEKDATA, child, (void *)regs.rsp, 0);
                errno = 0;
                unsigned long stack_field = (unsigned long)ptrace(
                    PTRACE_PEEKDATA, child, (void *)(regs.rsp + 16), 0);
                int bad_stack_field = errno;
                errno = 0;
                unsigned long frame_return = (unsigned long)ptrace(
                    PTRACE_PEEKDATA, child, (void *)(regs.rsp + 0xd8), 0);
                errno = 0;
                unsigned long array_pointer = (unsigned long)ptrace(
                    PTRACE_PEEKDATA, child, (void *)(regs.rbx + 0x48), 0);
                int bad_array = errno;
                errno = 0;
                unsigned long array_header = (unsigned long)ptrace(
                    PTRACE_PEEKDATA, child,
                    (void *)(array_pointer + 0x0), 0);
                int bad_header = errno;
                fprintf(stderr, "break=%llu rip=0x%llx rdi=0x%llx "
                       "[rdi]=%s0x%016lx "
                       "rsi=0x%llx [rdi+0x48]=%s0x%016lx "
                       "rax=0x%llx rdx=0x%llx rcx=0x%llx "
                       "r12=0x%llx r13=0x%llx [r13]=%s0x%016lx "
                       "rbp=0x%llx [rbp]=%s0x%016lx "
                       "r8=0x%llx r9=0x%llx r10=0x%llx r11=0x%llx "
                       "array=%s0x%016lx header=%s0x%016lx "
                       "[rsi]=%s0x%016lx [rsi+8]=%s0x%016lx "
                       "rbx=0x%llx [rbx+8]=%s0x%016lx "
                       "rsp=0x%llx return=0x%016lx "
                       "stack+16=%s0x%016lx "
                       "frame-return=%s0x%016lx\n",
                       ++hits, (unsigned long long)regs.rip,
                       (unsigned long long)regs.rdi,
                       bad_pointed ? "invalid/" : "", pointed,
                       (unsigned long long)regs.rsi,
                       bad_first_field ? "invalid/" : "", first_field,
                       (unsigned long long)regs.rax,
                       (unsigned long long)regs.rdx,
                       (unsigned long long)regs.rcx,
                       (unsigned long long)regs.r12,
                       (unsigned long long)regs.r13,
                       bad_saved_align ? "invalid/" : "", saved_align,
                       (unsigned long long)regs.rbp,
                       bad_base_align ? "invalid/" : "", base_align,
                       (unsigned long long)regs.r8,
                       (unsigned long long)regs.r9,
                       (unsigned long long)regs.r10,
                       (unsigned long long)regs.r11,
                       bad_array ? "invalid/" : "", array_pointer,
                       bad_header ? "invalid/" : "", array_header,
                       bad_align ? "invalid/" : "", align_field,
                       bad_rsi ? "invalid/" : "", argument_field,
                       (unsigned long long)regs.rbx,
                       bad_rbx ? "invalid/" : "", field,
                       (unsigned long long)regs.rsp, return_address,
                       bad_stack_field ? "invalid/" : "", stack_field,
                       errno ? "invalid/" : "", frame_return);
                fflush(stderr);
                if (indirect_words && !bad_pointed) {
                    errno = 0;
                    unsigned long address = (unsigned long)ptrace(
                        PTRACE_PEEKDATA, child,
                        (void *)(pointed + indirect_offset), 0);
                    if (errno) return 2;
                    fprintf(stderr, "indirect base=0x%lx offset=0x%llx "
                            "address=0x%lx\n", pointed,
                            indirect_offset, address);
                    for (unsigned long long i = 0; i < indirect_words; ++i) {
                        errno = 0;
                        unsigned long value = (unsigned long)ptrace(
                            PTRACE_PEEKDATA, child,
                            (void *)(address + i * sizeof(long)), 0);
                        if (errno) return 2;
                        fprintf(stderr, "indirect[%llu]=0x%016lx\n", i,
                                value);
                    }
                    fflush(stderr);
                }
                if (trace_from_hit && hits == trace_from_hit) {
                    trace_previous_rip = regs.rip;
                    stepping = 2;
                    continue;
                }
                if (watch_on_hit && hits == watch_on_hit) {
                    watch_address = regs.rsi + 8;
                    if (ptrace(PTRACE_POKEUSER, child,
                            (void *)offsetof(struct user, u_debugreg[0]),
                            (void *)(uintptr_t)watch_address)
                        || ptrace(PTRACE_POKEUSER, child,
                            (void *)offsetof(struct user, u_debugreg[7]),
                            (void *)(uintptr_t)0x90001u))
                        return 2;
                    fprintf(stderr, "watch-address=0x%llx\n", watch_address);
                    fflush(stderr);
                }
                stepping = 1;
                continue;
            }
            if (watch_address) {
                siginfo_t trap;
                if (ptrace(PTRACE_GETSIGINFO, child, 0, &trap)) return 2;
                if (trap.si_code == TRAP_HWBKPT) {
                    errno = 0;
                    unsigned long word = (unsigned long)ptrace(
                        PTRACE_PEEKDATA, child, (void *)watch_address, 0);
                    int bad_word = errno;
                    errno = 0;
                    unsigned long return_address = (unsigned long)ptrace(
                        PTRACE_PEEKDATA, child, (void *)regs.rsp, 0);
                    errno = 0;
                    unsigned long caller_address = (unsigned long)ptrace(
                        PTRACE_PEEKDATA, child, (void *)(regs.rsp + 16), 0);
                    int bad_stack16 = errno;
                    errno = 0;
                    unsigned long callback = (unsigned long)ptrace(
                        PTRACE_PEEKDATA, child, (void *)(regs.r12 + 0x68), 0);
                    int bad_callback = errno;
                    fprintf(stderr, "watch rip=0x%llx value=%s0x%016lx "
                           "rdi=0x%llx rsi=0x%llx rdx=0x%llx "
                           "rcx=0x%llx rbx=0x%llx r8=0x%llx r9=0x%llx "
                           "r10=0x%llx r11=0x%llx r14=0x%llx "
                           "rsp=0x%llx stack0=0x%016lx "
                           "stack16=%s0x%016lx r12=0x%llx "
                           "callback=%s0x%016lx\n",
                           (unsigned long long)regs.rip,
                           bad_word ? "invalid/" : "", word,
                           (unsigned long long)regs.rdi,
                           (unsigned long long)regs.rsi,
                           (unsigned long long)regs.rdx,
                           (unsigned long long)regs.rcx,
                           (unsigned long long)regs.rbx,
                           (unsigned long long)regs.r8,
                           (unsigned long long)regs.r9,
                           (unsigned long long)regs.r10,
                           (unsigned long long)regs.r11,
                           (unsigned long long)regs.r14,
                           (unsigned long long)regs.rsp,
                           return_address,
                           bad_stack16 ? "invalid/" : "", caller_address,
                           (unsigned long long)regs.r12,
                           bad_callback ? "invalid/" : "", callback);
                    fflush(stderr);
                    continue;
                }
            }
        }
        if (signal == SIGSEGV || signal == SIGILL || signal == SIGBUS) {
            struct user_regs_struct regs;
            siginfo_t info;
            if (ptrace(PTRACE_GETREGS, child, 0, &regs)
                    || ptrace(PTRACE_GETSIGINFO, child, 0, &info))
                return 2;
            if (step_tail) {
                unsigned long long start = step_count > RIP_HISTORY
                    ? step_count - RIP_HISTORY : 0u;
                fprintf(stderr, "trace steps=%llu\n", step_count);
                for (unsigned long long index = start;
                        index < step_count; ++index)
                    fprintf(stderr, "before[%llu]=0x%llx\n", index,
                           last_rips[index % RIP_HISTORY]);
            }
            fprintf(stderr, "signal=%d code=%d address=%p rip=0x%llx rsp=0x%llx "
                   "rax=0x%llx rdi=0x%llx rsi=0x%llx "
                   "rcx=0x%llx rdx=0x%llx rbx=0x%llx rbp=0x%llx "
                   "r8=0x%llx r9=0x%llx r10=0x%llx r11=0x%llx "
                   "r12=0x%llx r13=0x%llx r14=0x%llx r15=0x%llx\n",
                   signal, info.si_code, info.si_addr,
                   (unsigned long long)regs.rip,
                   (unsigned long long)regs.rsp,
                   (unsigned long long)regs.rax,
                   (unsigned long long)regs.rdi,
                   (unsigned long long)regs.rsi,
                   (unsigned long long)regs.rcx,
                   (unsigned long long)regs.rdx,
                   (unsigned long long)regs.rbx,
                   (unsigned long long)regs.rbp,
                   (unsigned long long)regs.r8,
                   (unsigned long long)regs.r9,
                   (unsigned long long)regs.r10,
                   (unsigned long long)regs.r11,
                   (unsigned long long)regs.r12,
                   (unsigned long long)regs.r13,
                   (unsigned long long)regs.r14,
                   (unsigned long long)regs.r15);
            for (int at = 0; at < 16 * (int)sizeof(long);
                    at += (int)sizeof(long)) {
                errno = 0;
                long word = ptrace(PTRACE_PEEKDATA, child,
                                   (void *)(regs.rsp + at), 0);
                if (!errno)
                    fprintf(stderr, "stack+%d: 0x%016lx\n", at,
                           (unsigned long)word);
            }
            char maps_path[64];
            snprintf(maps_path, sizeof maps_path, "/proc/%ld/maps",
                     (long)child);
            FILE *maps = fopen(maps_path, "r");
            if (maps) {
                char line[1024];
                while (fgets(line, sizeof line, maps)) {
                    unsigned long long begin, end, offset;
                    if (sscanf(line, "%llx-%llx %*4s %llx",
                               &begin, &end, &offset) != 3
                            || regs.rip < begin || regs.rip >= end)
                        continue;
                    fprintf(stderr, "rip-map: file-offset=0x%llx %s",
                           offset + (unsigned long long)regs.rip - begin,
                           line);
                    break;
                }
                fclose(maps);
            }
            for (int at = -16; at < 16; at += (int)sizeof(long)) {
                errno = 0;
                long word = ptrace(PTRACE_PEEKDATA, child,
                                   (void *)(regs.rip + at), 0);
                if (!errno)
                    fprintf(stderr, "rip%+d: 0x%016lx\n", at, (unsigned long)word);
            }
            return 1;
        }
    }
}
