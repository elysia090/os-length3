#include "internal/block.h"

#include <stdio.h>

static int equal(const pl_u8 *left, const pl_u8 *right, pl_u32 bytes)
{
    for (pl_u32 index = 0u; index < bytes; ++index)
        if (left[index] != right[index]) return 0;
    return 1;
}

int main(void)
{
    static const pl_u8 nop[] = { 0x90u };
    static const pl_u8 wide_nop[] = { 0x66u, 0x90u };
    static const pl_u8 clear[] = { 0x31u, 0xc0u };
    static const pl_x86_map maps[] = {
        { nop, 0x1000u, sizeof(nop), sizeof(nop),
          PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u },
        { wide_nop, 0x2000u, sizeof(wide_nop), sizeof(wide_nop),
          PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u },
        { clear, 0x3000u, sizeof(clear), sizeof(clear),
          PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u },
    };
    static const pl_x86_image image = { maps, 3u, 0u, 0x1000u };
    pl_x86_frontend frontend;
    pl_u8 first[8192], second[8192];
    pl_u8 output_a[8192], output_b[8192], output_c[8192];
    pl_x86_block_workspace workspace = {
        first, second, sizeof(first), 1u,
    };
    pl_u32 a = 0u, b = 0u, c = 0u;
    int status = pl_x86_frontend_open(&image, &frontend);
    if (!status)
        status = pl_x86_instruction_law_write(
            &frontend, 0x1000u, &workspace,
            output_a, sizeof(output_a), &a);
    if (!status)
        status = pl_x86_instruction_law_write(
            &frontend, 0x2000u, &workspace,
            output_b, sizeof(output_b), &b);
    if (!status && (a != b || !equal(output_a, output_b, a)))
        status = PL_ERROR_BLOCK;
    if (!status)
        status = pl_x86_instruction_law_write(
            &frontend, 0x3000u, &workspace,
            output_c, sizeof(output_c), &c);
    if (!status && a == c && equal(output_a, output_c, a))
        status = PL_ERROR_BLOCK;
    if (status) {
        fprintf(stderr, "canonical instruction law: RED (%d)\n", status);
        return 1;
    }
    printf("canonical instruction law: green "
           "(90/6690 -> one SSA law; xor remains distinct)\n");
    return 0;
}
