/* Calls through GOT slots that a static link fills itself. Each call below
 * is `call *f@GOTPCREL(%rip)`, assembled without relaxation, so the linker
 * makes a slot holding f's address and no relocation of the slot's own says
 * so: only the GOTPCREL row of the call does. Moving f must rebind the slot,
 * or the call lands where f used to be. Exits 42 when every call reached its
 * function. Built with -mno-red-zone: the calls are made from inline asm. */

__attribute__((noinline, used)) int add_one(int x) { return x + 1; }
__attribute__((noinline, used)) int add_two(int x) { return x + 2; }

#define VIA_GOT(name)                                                         \
    static int via_##name(int x)                                              \
    {                                                                         \
        int result;                                                           \
        __asm__ volatile("call *" #name "@GOTPCREL(%%rip)"                    \
                         : "=a"(result), "+D"(x)                              \
                         :                                                    \
                         : "rcx", "rdx", "rsi", "r8", "r9", "r10", "r11",     \
                           "memory", "cc");                                   \
        return result;                                                        \
    }
VIA_GOT(add_one)
VIA_GOT(add_two)

__attribute__((noreturn)) static void leave(int status)
{
    __asm__ volatile("syscall" :: "a"(60), "D"(status) : "rcx", "r11", "memory");
    __builtin_unreachable();
}

void _start(void)
{
    int total = 0;
    for (int i = 0; i < 10; ++i) total += i & 1 ? via_add_one(i) : via_add_two(i);
    /* 45 + 5 * 1 + 5 * 2 = 60. */
    leave(total - 18);
}
