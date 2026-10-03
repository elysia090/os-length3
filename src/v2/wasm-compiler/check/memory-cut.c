#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <machine/memory.h>
#include <x86/decode.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stddef.h>
#include <sys/mman.h>
#include <signal.h>
#include <setjmp.h>
#include <ucontext.h>
#include "native-selectors.h"

extern void native_cut(machine_state *state, const void *code);
static sigjmp_buf fault_return;
static machine_state fault_state;
static pl_u64 fault_address, fault_vector, fault_error;
static void memory_exception(int number, siginfo_t *info, void *pointer)
{
    (void)number;
    const ucontext_t *context = pointer;
    static const int ranks[] = {REG_RAX,REG_RCX,REG_RDX,REG_RBX,REG_RSP,REG_RBP,REG_RSI,REG_RDI,
        REG_R8,REG_R9,REG_R10,REG_R11,REG_R12,REG_R13,REG_R14,REG_R15};
    for (pl_u32 i = 0u; i < 16u; ++i) fault_state.registers[i] = (pl_u64)context->uc_mcontext.gregs[ranks[i]];
    fault_state.rflags = (pl_u64)context->uc_mcontext.gregs[REG_EFL];
    fault_state.rip = (pl_u64)context->uc_mcontext.gregs[REG_RIP];
    fault_address = (pl_u64)(uintptr_t)info->si_addr;
    fault_vector = (pl_u64)context->uc_mcontext.gregs[REG_TRAPNO];
    fault_error = (pl_u64)context->uc_mcontext.gregs[REG_ERR];
    siglongjmp(fault_return,1);
}
static int observe_fault(machine_state *state, const void *code)
{
    if (sigsetjmp(fault_return,1)) return 1;
    native_cut(state,code); return 0;
}
static pl_u64 random_word(pl_u64 *seed)
{ *seed ^= *seed << 13u; *seed ^= *seed >> 7u; *seed ^= *seed << 17u; return *seed; }
static FILE *output(const char *prefix, const char *suffix)
{
    char path[4096]; int count = snprintf(path, sizeof path, "%s.%s", prefix, suffix);
    return count > 0 && (size_t)count < sizeof path ? fopen(path, "wb") : NULL;
}
static pl_u64 read_word(const pl_u8 *bytes)
{
    pl_u64 value = 0u;
    for (pl_u32 i = 0u; i < 8u; ++i) value |= (pl_u64)bytes[i] << (8u * i);
    return value;
}
static pl_u64 bit_word_offset(pl_u64 index,pl_u32 width)
{
    index &= ~0ull >> (64u-width);
    pl_u64 offset=index >> 3u;
    if (index & (1ull << (width-1u))) offset |= ~0ull << (width-3u);
    return offset & (0u-(pl_u64)(width/8u));
}
static int close_output(FILE **file)
{
    int status = fclose(*file); *file = NULL; return status;
}

int main(int argc, char **argv)
{
    if (argc != 3) return 2;
    FILE *file = NULL, *prefix_file = NULL, *wasm = NULL, *cases = NULL, *meta = NULL, *source_page = NULL, *faults = NULL;
    struct sigaction old_action;
    int action_installed = 0;
    pl_u8 *data = NULL, *ram = NULL;
    void *code = MAP_FAILED;
    size_t code_bytes = 0u;
    int relative = 0, result = 2;
    pl_u64 bytes = 0u;
    file = fopen(argv[1], "rb"); long size;
    if (!file || fseek(file, 0, SEEK_END) || (size = ftell(file)) <= 0
            || fseek(file, 0, SEEK_SET)) goto finish;
    data = malloc((size_t)size);
    if (!data || fread(data, 1u, (size_t)size, file) != (size_t)size) goto finish;
    if (close_output(&file)) goto finish;
    wasm_compiler compiler;
    pl_elf_image elf;
    if (wasm_compiler_open(&compiler, data, (pl_u64)size)
            || pl_elf_open(data, (pl_u64)size, &elf)) goto finish;
    wasm_cut_options options = { elf.entry, 1024u, 16384u };
    wasm_cut_report report;
    int status = wasm_compiler_measure_cut(&compiler, &options, &bytes, &report);
    if (status) { fprintf(stderr, "memory cut refused (%d)\n", status); result = 1; goto finish; }
    result = 1;
    if (!report.memory_bytes) {
        if (report.boundary != WASM_CUT_MEMORY || report.source_instructions != 1u
                || report.continuation <= elf.entry) goto finish;
        pl_u8 prefix_module[16384]; pl_u64 prefix_bytes;
        if (wasm_compiler_emit_cut(&compiler, &options, prefix_module, sizeof prefix_module,
                                   &prefix_bytes, NULL)) goto finish;
        prefix_file = output(argv[2], "prefix.wasm");
        if (!prefix_file || fwrite(prefix_module, 1u, (size_t)prefix_bytes, prefix_file) != prefix_bytes
                || close_output(&prefix_file)) goto finish;
        options.entry = report.continuation;
        status = wasm_compiler_measure_cut(&compiler, &options, &bytes, &report);
    }
    if (status || !report.memory_bytes || report.source_instructions != 1u
            || report.boundary != WASM_CUT_MEMORY) goto finish;
    pl_u8 module[16384]; pl_u64 written = 0u;
    if (wasm_compiler_emit_cut(&compiler, &options, module, sizeof module, &written, &report)
            || written != bytes) goto finish;
    wasm = output(argv[2], "wasm");
    if (!wasm || fwrite(module, 1u, (size_t)bytes, wasm) != bytes || close_output(&wasm)) goto finish;
    for (pl_u32 i = 0u; i < elf.program_count; ++i) {
        pl_elf_segment segment;
        if (pl_elf_program(&elf, i, &segment)) goto finish;
        if (!pl_elf_segment_is_executable(&segment)) continue;
        if (report.entry < segment.virtual_address
                || report.entry - segment.virtual_address >= segment.file_bytes) continue;
        pl_u64 base = segment.virtual_address & ~4095ull;
        pl_u64 prefix = segment.virtual_address - base;
        pl_u64 rounded;
        if (!pl_checked_add_u64(prefix, segment.memory_bytes, &rounded)
                || !pl_checked_add_u64(rounded, 4095u, &rounded)) goto finish;
        rounded &= ~4095ull;
        if (!rounded || rounded > SIZE_MAX) goto finish;
        code_bytes = (size_t)rounded;
        code = mmap((void *)(uintptr_t)base, code_bytes, PROT_READ | PROT_WRITE,
                    MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
        if (code == MAP_FAILED) { perror("native code mapping"); goto finish; }
        memcpy((pl_u8 *)code + prefix, data + segment.file_offset, (size_t)segment.file_bytes);
        if (report.continuation < base || report.continuation - base >= code_bytes) goto finish;
        ((pl_u8 *)code)[report.continuation - base] = 0xc3u;
        if (mprotect(code, code_bytes, PROT_READ | PROT_EXEC)) goto finish;
        break;
    }
    if (code == MAP_FAILED) goto finish;
    source_page = output(argv[2], "source-page");
    if (!source_page || fwrite((const void *)(uintptr_t)(report.entry & ~4095ull),
                                1u, 4096u, source_page) != 4096u || close_output(&source_page)) goto finish;
    pl_x86_map map = { code, (pl_u64)(uintptr_t)code, code_bytes, code_bytes, 5u, 1u };
    pl_x86_image image = { &map, 1u, 0u, report.entry };
    pl_x86_instruction instruction;
    if (pl_x86_decode_profile(&image, report.entry, &instruction)) goto finish;
    int store = instruction.operands[0].kind == PL_X86_OPERAND_MEMORY;
    int unary = instruction.operation == PL_X86_OPERATION_INCREMENT
        || instruction.operation == PL_X86_OPERATION_DECREMENT
        || instruction.operation == PL_X86_OPERATION_NEGATE
        || instruction.operation == PL_X86_OPERATION_COMPLEMENT;
    int exchange = instruction.operation == PL_X86_OPERATION_COMPARE_EXCHANGE;
    int multiply = instruction.operation == PL_X86_OPERATION_MULTIPLY_SIGNED
        || instruction.operation == PL_X86_OPERATION_MULTIPLY_UNSIGNED;
    int carry = instruction.operation == PL_X86_OPERATION_ADD_CARRY
        || instruction.operation == PL_X86_OPERATION_SUBTRACT_BORROW;
    int implicit = multiply && instruction.visible_operand_count == 1u;
    int set = instruction.operation == PL_X86_OPERATION_CONDITIONAL_SET;
    int selector = instruction.machine_operation == PL_X86_MACHINE_READ_SELECTOR;
    int summary = instruction.operation == PL_X86_OPERATION_BIT_SUMMARY;
    int scan = summary && instruction.condition < 2u;
    unsigned legacy_prefix_twin = 0u;
    if (scan) for (pl_u32 at=0u;at<instruction.length && instruction.source[at]!=0x0fu;++at) {
        if (instruction.source[at]!=0xf3u) continue;
        if (at) goto finish; /* This witness requires a leading one-byte prefix. */
        /* Observe an ISA-equivalent native legacy scan, not the host's
         * TZCNT/LZCNT extension. Keep product/source-page bytes unchanged.
         * NOP replaces only this oracle prefix and preserves coordinates. */
        if (mprotect(code,code_bytes,PROT_READ | PROT_WRITE | PROT_EXEC)) goto finish;
        *((pl_u8 *)(uintptr_t)instruction.rip+at)=0x90u;
        if (mprotect(code,code_bytes,PROT_READ | PROT_EXEC)) goto finish;
        legacy_prefix_twin=1u;
    }
    pl_u64 selectors[6]; native_selectors(selectors);
    int bit = instruction.operation == PL_X86_OPERATION_BIT_TEST;
    int indexed_bit = bit && instruction.operands[1].kind == PL_X86_OPERAND_REGISTER;
    int precise_rmw = unary || exchange || (bit && instruction.condition) || (carry && store);
    int precise_write = precise_rmw || set || selector;
    const pl_x86_memory *operand = &instruction.operands[store ? 0u : 1u].value.memory;
    relative = operand->base.class_id == PL_X86_REGISTER_IP;
    /* High application memory, not ASan's reserved low shadow/gap. */
    pl_u64 base = instruction.address_width == 32u ? 0x23456000ull : 0x123456789000ull;
    if (relative) base = (instruction.fallthrough + (pl_u64)operand->displacement) & ~4095ull;
    if (relative) ram = (pl_u8 *)(uintptr_t)base; /* borrowed private executable mapping */
    else ram = mmap((void *)(uintptr_t)base, 8192u, PROT_READ | PROT_WRITE,
                    MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
    if (ram == MAP_FAILED) { perror("native RAM mapping"); goto finish; }
    if (relative) {
        pl_u64 address = instruction.fallthrough + (pl_u64)operand->displacement;
        if (address < (pl_u64)(uintptr_t)code || code_bytes < 8u
                || address - (pl_u64)(uintptr_t)code > code_bytes - 8u) goto finish;
        if (((report.memory_access & MACHINE_MEMORY_WRITE) || indexed_bit || summary)
                && mprotect(code,code_bytes,PROT_READ | PROT_WRITE | PROT_EXEC)) goto finish;
    }
    if (!relative && (instruction.operation == PL_X86_OPERATION_CONDITIONAL_MOVE
            || instruction.operation == PL_X86_OPERATION_BIT_TEST || multiply || carry || precise_write || summary)) {
        struct sigaction action = {.sa_sigaction=memory_exception,.sa_flags=SA_SIGINFO};
        sigemptyset(&action.sa_mask);
        if (sigaction(SIGSEGV,&action,&old_action)) goto finish;
        action_installed = 1;
        faults = output(argv[2],"faults");
        if (!faults) goto finish;
    }
    cases = output(argv[2], "cases"); meta = output(argv[2], "json");
    if (!cases || !meta) goto finish;
    pl_u64 seed = 0xa56e14dfabc81234ull;
    pl_u8 saved[8192]; int okay = 1;
    for (pl_u32 row = 0u; row < 512u; ++row) {
        machine_state state = { 0 }; pl_u64 record[38];
        for (pl_u32 reg = 0u; reg < 16u; ++reg) state.registers[reg] = random_word(&seed);
        state.rflags = 0x202u | (random_word(&seed) & 0x8d5u);
        if (set && row < 256u) {
            static const pl_u32 positions[] = {0u,2u,4u,6u,7u,11u};
            state.rflags = 0x202u;
            for (pl_u32 flag_rank=0u;flag_rank<6u;++flag_rank)
                state.rflags |= (pl_u64)((row>>flag_rank)&1u) << positions[flag_rank];
        }
        if (unary || carry) state.rflags = (state.rflags & ~1ull) | (row & 1u);
        pl_u32 offset = row % 3u == 0u ? 4093u : row % 3u == 1u ? 0u : 4088u;
        if (set) offset = row&1u ? 4095u : 0u;
        if (selector) offset = row%3u==0u ? 4095u : row%3u==1u ? 0u : 4094u;
        pl_u64 address = base + offset;
        pl_u64 word_offset=0u;
        if (indexed_bit) {
            pl_u32 width=report.memory_bytes*8u, index_register=instruction.operands[1].value.reg.index;
            pl_u64 mask=~0ull >> (64u-width), sign=1ull << (width-1u);
            const pl_u64 edges[]={0u,1u,width-1u,width,width+1u,2u*width-1u,2u*width,
                ~0ull,0u-(pl_u64)width,0u-(pl_u64)width-1u,0u-2u*(pl_u64)width,
                0u-2u*(pl_u64)width-1u,255u,0ull-255u,sign,sign-1u,sign+1u,mask,mask-1u};
            pl_u64 index=row<128u ? edges[row%(relative ? 14u : 19u)]
                : random_word(&seed) & (relative ? 511u : 65535u);
            if (row>=128u && (row&1u)) index=0u-index;
            state.registers[index_register]=(state.registers[index_register]&~mask)|(index&mask);
            word_offset=bit_word_offset(index,width);
        }
        if (!relative) {
            for (pl_u32 i = 0u; i < 8192u; ++i) ram[i] = (pl_u8)(i * 37u + row * 13u);
            if (operand->base.class_id != PL_X86_REGISTER_GPR || operand->base.index >= 16u)
                goto finish;
            pl_u32 base_register = operand->base.index;
            state.registers[base_register] = address - word_offset - (pl_u64)operand->displacement;
            if (operand->index.class_id == PL_X86_REGISTER_GPR) {
                if (!indexed_bit || operand->index.index != instruction.operands[1].value.reg.index)
                    state.registers[operand->index.index] = row & 15u;
                state.registers[base_register] -= state.registers[operand->index.index] * operand->scale;
            }
            if (instruction.address_width == 32u) state.registers[base_register] |= 0xdeadbeef00000000ull;
        } else address = instruction.fallthrough + (pl_u64)operand->displacement + word_offset;
        if (carry && !relative && row<288u) {
            pl_u32 width=report.memory_bytes*8u; pl_u64 mask=~0ull>>(64u-width),sign=1ull<<(width-1u);
            const pl_u64 edges[]={0u,1u,mask,mask-1u,sign,sign-1u,sign+1u,15u,16u,255u,256u,~15ull};
            pl_u64 value=edges[(row/2u)%12u]&mask;
            const pl_x86_operand *other=&instruction.operands[store ? 1u : 0u];
            if (other->kind==PL_X86_OPERAND_REGISTER) {
                pl_u32 reg=other->value.reg.index,shift=other->value.reg.flags&PL_X86_REGISTER_HIGH8 ? 8u : 0u;
                if (!(operand->base.class_id==PL_X86_REGISTER_GPR && operand->base.index==reg)
                        && !(operand->index.class_id==PL_X86_REGISTER_GPR && operand->index.index==reg))
                    state.registers[reg]=(state.registers[reg]&~(mask<<shift))
                        | ((edges[(row/24u)%12u]&mask)<<shift);
            }
            for (pl_u32 i=0u;i<report.memory_bytes;++i)
                ((pl_u8 *)(uintptr_t)address)[i]=(pl_u8)(value>>(8u*i));
        }
        if (multiply && !relative && row < 256u) {
            pl_u32 width = report.memory_bytes*8u, destination=implicit ? 0u : instruction.operands[0].value.reg.index;
            pl_u64 sign = 1ull << (width-1u), mask = ~0ull >> (64u-width);
            const pl_u64 edges[] = {0u,1u,mask,mask-1u,sign,sign-1u,sign+1u,127u,128u,
                255u,256u,0xffffffffu,0x100000000ull,0x80000000u,0x8000000000000000ull,~0ull};
            pl_u64 value=edges[row%16u]&mask;
            if ((instruction.visible_operand_count==2u || implicit)
                    && !(operand->base.class_id==PL_X86_REGISTER_GPR && operand->base.index==destination)
                    && !(operand->index.class_id==PL_X86_REGISTER_GPR && operand->index.index==destination))
                state.registers[destination]=(state.registers[destination]&~mask)|(edges[(row/16u)%16u]&mask);
            for (pl_u32 i=0u;i<report.memory_bytes;++i)
                ((pl_u8 *)(uintptr_t)address)[i]=(pl_u8)(value >> (8u*i));
        }
        if (summary) {
            pl_u32 width=report.memory_bytes*8u, edge=(row/2u)%(width+3u);
            pl_u64 mask=~0ull>>(64u-width);
            pl_u64 value=row<256u ? (edge==0u ? 0u : edge<=width ? 1ull<<(edge-1u)
                : edge==width+1u ? mask : mask>>1u) : random_word(&seed)&mask;
            for (pl_u32 i=0u;i<report.memory_bytes;++i)
                ((pl_u8 *)(uintptr_t)address)[i]=(pl_u8)(value>>(8u*i));
        }
        if (indexed_bit && row<128u) {
            pl_u64 value=row&1u ? (~0ull >> (64u-report.memory_bytes*8u)) : 0u;
            for (pl_u32 i=0u;i<report.memory_bytes;++i)
                ((pl_u8 *)(uintptr_t)address)[i]=(pl_u8)(value >> (8u*i));
        }
        if (unary && row < 48u) {
            pl_u32 width = report.memory_bytes*8u;
            pl_u64 sign = 1ull << (width-1u), mask = width == 64u ? ~0ull : (1ull << width)-1u;
            const pl_u64 edges[] = {0u,1u,mask,mask-1u,sign,sign-1u,sign+1u,15u,16u,255u,256u,~15ull};
            pl_u64 value = edges[(row/2u) % (sizeof edges/sizeof edges[0])] & mask;
            for (pl_u32 i=0u;i<report.memory_bytes;++i)
                ((pl_u8 *)(uintptr_t)address)[i]=(pl_u8)(value >> (8u*i));
        }
        if (exchange) {
            pl_u32 width = report.memory_bytes*8u;
            pl_u64 mask = ~0ull >> (64u-width), sign = 1ull << (width-1u);
            const pl_u64 edges[] = {0u,1u,mask,mask-1u,sign,sign-1u,sign+1u,15u,16u,255u,256u,~15ull};
            if (row < 96u && !(operand->base.class_id == PL_X86_REGISTER_GPR && !operand->base.index)
                    && !(operand->index.class_id == PL_X86_REGISTER_GPR && !operand->index.index))
                state.registers[0] = (state.registers[0]&~mask)|(edges[(row/2u)%12u]&mask);
            pl_u64 acc = state.registers[0]&mask;
            pl_u64 value = row&1u ? (row < 96u ? edges[(row/2u+5u)%12u] : random_word(&seed))&mask : acc;
            if ((row&1u) && value == acc) value ^= 1u;
            for (pl_u32 i=0u;i<report.memory_bytes;++i)
                ((pl_u8 *)(uintptr_t)address)[i]=(pl_u8)(value >> (8u*i));
        }
        if (!relative) memcpy(saved,ram,sizeof saved);
        for (pl_u32 reg = 0u; reg < 16u; ++reg) record[reg] = state.registers[reg];
        record[16] = state.rflags; record[35] = address;
        record[36] = read_word((const pl_u8 *)(uintptr_t)address);
        native_cut(&state, (const void *)(uintptr_t)report.entry);
        record[4] = state.registers[4];
        for (pl_u32 reg = 0u; reg < 16u; ++reg) record[17u + reg] = state.registers[reg];
        record[33] = state.rflags; record[34] = report.continuation;
        /* AF has no defined native value for logical operations. The compiled
         * long-mode projection canonically clears this undefined flag. */
        if (instruction.operation == PL_X86_OPERATION_AND || instruction.operation == PL_X86_OPERATION_OR
                || instruction.operation == PL_X86_OPERATION_XOR
                || instruction.operation == PL_X86_OPERATION_TEST) record[33] &= ~0x10ull;
        if (instruction.operation == PL_X86_OPERATION_BIT_TEST) {
            /* CF is the native oracle; OF/SF/AF/PF are undefined, not zero.
             * Validate all other flags before choosing the incoming values. */
            if ((record[33]^record[16])&~0x895ull) goto finish;
            record[33]=(record[33]&1u)|(record[16]&~1ull);
        }
        if (multiply) {
            /* CF/OF are the native oracle. SF/ZF/AF/PF are undefined, not
             * required native outputs; choose their incoming representative.
             * Every other flag must match before that choice is made. */
            if ((record[33]^record[16])&~0x8d5ull) goto finish;
            record[33]=(record[33]&~0xd4ull)|(record[16]&0xd4u);
        }
        if (scan) {
            /* Only ZF is defined among arithmetic flags. All other flags
             * outside that undefined set must match the native observation.
             * A zero-source destination is also undefined: choose the whole
             * incoming parent, never relabel it as a defined hardware result. */
            if ((record[33]^record[16])&~0x8d5ull) goto finish;
            record[33]=(record[33]&0x40u)|(record[16]&~0x40ull);
            if (!(record[36]&(~0ull>>(64u-report.memory_bytes*8u)))) {
                pl_u32 destination=instruction.operands[0].value.reg.index;
                record[17u+destination]=record[destination];
            }
        }
        record[37] = read_word((const pl_u8 *)(uintptr_t)address);
        if (instruction.operation == PL_X86_OPERATION_COMPLEMENT && record[33] != record[16]) goto finish;
        if (set && record[33] != record[16]) goto finish;
        if (selector && record[33] != record[16]) goto finish;
        if ((instruction.operation == PL_X86_OPERATION_INCREMENT || instruction.operation == PL_X86_OPERATION_DECREMENT)
                && ((record[33]^record[16])&1u)) goto finish;
        if (!relative) {
            if (report.memory_access & MACHINE_MEMORY_WRITE) memcpy(saved + offset, ram + offset, report.memory_bytes);
            if (memcmp(saved, ram, sizeof saved)) okay = 0;
        }
        if (fwrite(record, sizeof record, 1u, cases) != 1u) okay = 0;
        if (faults) {
            /* Protect the last operand fragment, including split pages.
             * RMW alternates non-present and readable-but-not-writable
             * memory: a successful read must not hide the write fault. */
            for (pl_u32 reg = 0u; reg < 16u; ++reg) state.registers[reg] = record[reg];
            state.rflags = record[16];
            pl_u8 *protected_page = ram + (((address - base) + report.memory_bytes - 1u) & ~4095ull);
            if (exchange || set || selector || (bit && instruction.condition) || (carry && store)) for (pl_u32 i=0u;i<report.memory_bytes;++i)
                ((pl_u8 *)(uintptr_t)address)[i]=(pl_u8)(record[36] >> (8u*i));
            if (precise_write) memcpy(saved,ram,sizeof saved);
            int readable = precise_write && (set ? (row&64u) : exchange ? (row&2u) : (row&1u));
            if (mprotect(protected_page,4096u,readable ? PROT_READ : PROT_NONE)) goto finish;
            int trapped = observe_fault(&state,(const void *)(uintptr_t)report.entry);
            if (mprotect(protected_page,4096u,PROT_READ | PROT_WRITE)) goto finish;
            if (precise_write && memcmp(saved,ram,sizeof saved)) goto finish;
            /* The leading oracle-only NOP is a separate retired instruction.
             * Retain that actual fault RIP; the reader must explicitly map
             * this one-byte twin coordinate back to the original prefix. */
            if (!trapped || fault_vector != 14u || fault_state.rip != report.entry+legacy_prefix_twin
                    || (fault_state.rflags & ~0x10000ull) != state.rflags) goto finish;
            pl_u64 observed[38];
            for (pl_u32 reg = 0u; reg < 16u; ++reg) {
                if (fault_state.registers[reg] != state.registers[reg]) goto finish;
                observed[reg] = state.registers[reg]; observed[17u + reg] = fault_state.registers[reg];
            }
            observed[16] = state.rflags; observed[33] = fault_state.rflags;
            observed[34] = fault_state.rip; observed[35] = fault_address;
            observed[36] = fault_vector; observed[37] = fault_error;
            if (fwrite(observed,sizeof observed,1u,faults) != 1u) okay = 0;
        }
    }
    if (fprintf(meta, "{\"entry\":%llu,\"prefixEntry\":%llu,\"moduleBytes\":%llu,\"sourceBytes\":%llu,\"bytes\":%u,\"access\":%u,"
                "\"stateBytes\":%zu,\"ripOffset\":%zu,\"flagsOffset\":%zu,\"retiredOffset\":%zu,"
                "\"selector\":{\"enabled\":%u,\"offset\":%zu,\"rank\":%u,"
                "\"native\":[\"%llu\",\"%llu\",\"%llu\",\"%llu\",\"%llu\",\"%llu\"]},"
                "\"summary\":{\"enabled\":%u,\"scan\":%u,\"destination\":%u,\"width\":%u,"
                "\"nativeLegacyPrefixTwin\":%u,\"nativeFaultOffset\":%u}}\n",
                report.entry, elf.entry, report.module_bytes, report.source_bytes, report.memory_bytes, report.memory_access,
                sizeof(machine_state), offsetof(machine_state, rip), offsetof(machine_state, rflags),
                offsetof(machine_state, retired),(unsigned)selector,
                offsetof(machine_state,system)+MACHINE_SYSTEM_ES*8u,instruction.operands[1].value.reg.index,
                selectors[0],selectors[1],selectors[2],selectors[3],selectors[4],selectors[5],
                (unsigned)summary,(unsigned)scan,instruction.operands[0].value.reg.index,
                summary ? report.memory_bytes*8u : 0u,legacy_prefix_twin,legacy_prefix_twin) < 0) okay = 0;
    result = okay ? 0 : 1;
finish:
    if (file && close_output(&file)) result = 1;
    if (prefix_file && close_output(&prefix_file)) result = 1;
    if (wasm && close_output(&wasm)) result = 1;
    if (cases && close_output(&cases)) result = 1;
    if (meta && close_output(&meta)) result = 1;
    if (source_page && close_output(&source_page)) result = 1;
    if (faults && close_output(&faults)) result = 1;
    if (action_installed && sigaction(SIGSEGV,&old_action,NULL)) result = 1;
    if (!relative && ram && ram != MAP_FAILED && munmap(ram, 8192u)) result = 1;
    if (code != MAP_FAILED && munmap(code, code_bytes)) result = 1;
    free(data);
    if (!result) printf("native memory cut: green (%llu bytes, access %u/%u)\n", bytes, report.memory_bytes, report.memory_access);
    return result;
}
