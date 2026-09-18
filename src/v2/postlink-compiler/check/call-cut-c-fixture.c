typedef unsigned long u64;

typedef struct {
    unsigned value;
} digest_descriptor;

digest_descriptor descriptor0 = { 7u };
digest_descriptor descriptor1 = { 13u };
digest_descriptor descriptor2 = { 22u };
digest_descriptor descriptor3 = { 31u };
digest_descriptor descriptor4 = { 43u };

digest_descriptor *digest0 = &descriptor0;
digest_descriptor *digest1 = &descriptor1;
digest_descriptor *digest2 = &descriptor2;
digest_descriptor *digest3 = &descriptor3;
digest_descriptor *digest4 = &descriptor4;

__attribute__((noinline, used))
unsigned consume_digest(const unsigned char *input,
                        const unsigned char *length,
                        const unsigned char *output,
                        const unsigned *written,
                        digest_descriptor *digest, void *engine)
{
    (void)engine;
    return (digest ? digest->value : 0u)
         + *input + *length + *output + *written;
}

__attribute__((noinline, used))
unsigned select_digest(unsigned char *output, unsigned char selector,
                       const unsigned char *input,
                       const unsigned char *length)
{
    unsigned written = 0u;
    digest_descriptor *digest;
    switch (selector) {
    case 0u: digest = digest0; break;
    case 1u: digest = digest1; break;
    case 2u: digest = digest2; break;
    case 3u: digest = digest3; break;
    case 4u: digest = digest4; break;
    default: digest = (digest_descriptor *)0; break;
    }
    unsigned value = consume_digest(
        input, length, output + 2, &written, digest, (void *)0);
    output[0] = selector;
    return value;
}

__attribute__((noreturn))
static void finish(unsigned status)
{
    register u64 number __asm__("rax") = 60u;
    register u64 argument __asm__("rdi") = status;
    __asm__ volatile("syscall"
                     : "+r"(number)
                     : "r"(argument)
                     : "rcx", "r11", "memory");
    __builtin_unreachable();
}

void _start(void)
{
    static unsigned char output[8];
    static const unsigned char input[1];
    static const unsigned char length[1];
    if (select_digest(output, 0u, input, length) != 7u
            || select_digest(output, 1u, input, length) != 13u
            || select_digest(output, 2u, input, length) != 22u
            || select_digest(output, 3u, input, length) != 31u
            || select_digest(output, 4u, input, length) != 43u)
        finish(1u);
    finish(42u);
}
