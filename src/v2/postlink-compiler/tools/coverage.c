/* postlink-coverage -- measure direct-Wasm closure over a machine artifact.
 *
 *     postlink-coverage MACHINE [OPCODE]
 *
 * Every admitted block is decoded through the C template/parameter path and
 * every node is passed to the production Wasm lowering.  The result is a
 * block-weighted grammar inventory, not a trace sample and not an interpreter.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <postlink/directory.h>
#include <postlink/plan.h>
#include <postlink/template.h>
#include <postlink/wasm.h>

typedef struct {
    pl_u32 opcode;
    unsigned long long total;
    unsigned long long rejected;
    unsigned long long unsupported;
    unsigned long long abi;
    unsigned long long other;
} opcode_row;

static int header_u32(const pl_u8 *header, pl_u32 bytes, const char *path,
                      pl_u32 *value)
{
    pl_u64 wide;
    if (pl_machine_header_u64(header, bytes, path, &wide)
            || wide > 0xffffffffull)
        return PL_ERROR_CONTAINER;
    *value = (pl_u32)wide;
    return 0;
}

static int descending_rejected(const void *left, const void *right)
{
    const opcode_row *a = left, *b = right;
    if (a->rejected < b->rejected) return 1;
    if (a->rejected > b->rejected) return -1;
    if (a->total < b->total) return 1;
    if (a->total > b->total) return -1;
    return a->opcode > b->opcode ? 1 : a->opcode < b->opcode ? -1 : 0;
}

int main(int argc, char **argv)
{
    if (argc < 2 || argc > 3) {
        fprintf(stderr, "usage: postlink-coverage MACHINE [OPCODE]\n");
        return 2;
    }
    long sample_opcode = argc == 3 ? strtol(argv[2], NULL, 0) : -1;
    unsigned sample_count = 0u;
    FILE *handle = fopen(argv[1], "rb");
    if (!handle) { fprintf(stderr, "cannot open %s\n", argv[1]); return 1; }
    if (fseek(handle, 0, SEEK_END)) { fclose(handle); return 1; }
    long size = ftell(handle);
    rewind(handle);
    pl_u8 *payload = size > 0 ? malloc((size_t)size) : NULL;
    if (!payload || fread(payload, 1u, (size_t)size, handle) != (size_t)size) {
        fprintf(stderr, "cannot read %s\n", argv[1]);
        free(payload);
        fclose(handle);
        return 1;
    }
    fclose(handle);

    pl_machine machine;
    int status = pl_machine_parse(payload, (pl_u64)size, &machine);
    if (status) {
        fprintf(stderr, "%s: %s\n", argv[1], pl_error_name(status));
        free(payload);
        return 1;
    }
    const pl_u8 *header = payload + machine.header_offset;
    pl_directory_counts counts;
    memset(&counts, 0, sizeof counts);
    struct { const char *path; pl_u32 *slot; } fields[] = {
        { "block_count", &counts.block_count },
        { "step_count", &counts.step_count },
        { "template_count", &counts.template_count },
        { "guard_count", &counts.guard_count },
        { "continuation_count", &counts.continuation_count },
        { "continuation_bytes", &counts.continuation_bytes },
        { "template_execution_bytes", &counts.template_execution_bytes },
        { "parameter_execution_bytes", &counts.parameter_execution_bytes },
    };
    for (unsigned index = 0; index < sizeof fields / sizeof fields[0]; ++index)
        if (header_u32(header, machine.header_bytes, fields[index].path,
                       fields[index].slot)) {
            fprintf(stderr, "header lacks %s\n", fields[index].path);
            free(payload);
            return 1;
        }
    counts.execution_bytes = (pl_u32)machine.execution.length;
    counts.schema = machine.schema;

    pl_directory directory;
    status = pl_directory_open(payload + machine.descriptors.offset,
                               machine.descriptors.length, &counts,
                               &directory);
    if (status) {
        fprintf(stderr, "descriptor region does not tile: %s\n",
                pl_error_name(status));
        free(payload);
        return 1;
    }

    const pl_u8 *execution = payload + machine.execution.offset;
    const pl_u32 arena_bytes = 1u << 22;
    pl_u8 *arena_base = malloc(arena_bytes);
    pl_u8 *failed_template = calloc(counts.template_count + 1u, 1u);
    opcode_row rows[PL_OPCODE_COUNT];
    unsigned long long block_status[32];
    memset(rows, 0, sizeof rows);
    memset(block_status, 0, sizeof block_status);
    for (pl_u32 opcode = 0; opcode < PL_OPCODE_COUNT; ++opcode)
        rows[opcode].opcode = opcode;
    if (!arena_base || !failed_template) {
        fprintf(stderr, "cannot allocate coverage workspace\n");
        free(failed_template);
        free(arena_base);
        free(payload);
        return 1;
    }

    unsigned long long admitted = 0, decoded = 0, block_ok = 0;
    unsigned long long admission_failed = 0, decode_failed = 0;
    unsigned long long node_total = 0, node_rejected = 0;
    unsigned long long rejected_templates = 0;
    for (pl_u32 index = 0; index < counts.block_count; ++index) {
        pl_admission admission;
        status = pl_directory_admit(&directory, index, &admission);
        if (status) { admission_failed += 1u; continue; }
        admitted += 1u;
        const pl_u8 *tmpl = execution + admission.tmpl.offset;
        pl_template parsed;
        status = pl_template_parse(
            tmpl, (pl_u32)admission.tmpl.length, &parsed);
        if (status) { decode_failed += 1u; continue; }
        pl_arena arena = { arena_base, arena_bytes, 0u };
        pl_plan plan;
        status = pl_plan_decode(tmpl, &parsed,
                                execution + admission.parameters.offset,
                                &arena, &plan);
        if (status) { decode_failed += 1u; continue; }
        decoded += 1u;

        int block_rejected = 0;
        for (pl_u32 value = 1u; value <= plan.node_count; ++value) {
            pl_u32 opcode = plan.nodes[value - 1u].opcode;
            node_total += 1u;
            if (opcode >= PL_OPCODE_COUNT) {
                node_rejected += 1u;
                block_rejected = 1;
                continue;
            }
            opcode_row *row = &rows[opcode];
            row->total += 1u;
            pl_u32 bytes = 0u;
            status = pl_wasm_node_measure(&plan, value, &bytes);
            if (!status) continue;
            (void)bytes;
            node_rejected += 1u;
            row->rejected += 1u;
            row->unsupported += status == PL_ERROR_WASM_UNSUPPORTED;
            row->abi += status == PL_ERROR_WASM_ABI;
            row->other += status != PL_ERROR_WASM_UNSUPPORTED
                       && status != PL_ERROR_WASM_ABI;
            if ((long)opcode == sample_opcode && sample_count < 20u) {
                printf("SAMPLE block=%u template=%u node=%u instructions=%u "
                       "status=%d args=",
                       index, admission.template_rank, value,
                       plan.instructions, status);
                const pl_node *node = &plan.nodes[value - 1u];
                for (pl_u32 at = 0u; at < node->argument_count; ++at) {
                    pl_operand operand = plan.arguments[
                        node->argument_at + at];
                    printf("%s%u:%llu", at ? "," : "", operand.kind,
                           (unsigned long long)operand.value);
                }
                printf("\n");
                if (sample_count < 5u) {
                    for (pl_u32 item = 0u; item < plan.node_count; ++item) {
                        const pl_node *held = &plan.nodes[item];
                        printf("  N %u %u", item + 1u, held->opcode);
                        for (pl_u32 at = 0u; at < held->argument_count; ++at) {
                            pl_operand operand = plan.arguments[
                                held->argument_at + at];
                            printf(" %u:%llu", operand.kind,
                                   (unsigned long long)operand.value);
                        }
                        printf("\n");
                    }
                    for (pl_u32 slot = 0u; slot < plan.local_count; ++slot) {
                        pl_operand operand = plan.locals[slot];
                        if (operand.kind == PL_OPERAND_LOCAL
                                && operand.value == slot)
                            continue;
                        printf("  L %u %u:%llu\n", slot, operand.kind,
                               (unsigned long long)operand.value);
                    }
                }
                sample_count += 1u;
            }
            block_rejected = 1;
        }

        pl_wasm_block block = {
            .plan = &plan,
            .next_rip = 0u,
            .result_kind = PL_VM_HALT,
        };
        pl_wasm_module_spec spec = { &block, 1u, NULL, 0u };
        pl_u32 module_bytes = 0u;
        status = pl_wasm_module_measure(&spec, &module_bytes);
        if (!status) block_ok += 1u;
        else {
            pl_u32 bucket = status < 0 && status >= -31 ? (pl_u32)-status : 0u;
            block_status[bucket] += 1u;
            block_rejected = 1;
        }
        if (block_rejected && admission.template_rank <= counts.template_count
                && !failed_template[admission.template_rank]) {
            failed_template[admission.template_rank] = 1u;
            rejected_templates += 1u;
        }
    }

    qsort(rows, PL_OPCODE_COUNT, sizeof rows[0], descending_rejected);
    printf("blocks                     %12u\n", counts.block_count);
    printf("  admitted                  %12llu\n", admitted);
    printf("  decoded                   %12llu\n", decoded);
    printf("  direct module             %12llu\n", block_ok);
    printf("  admission failures        %12llu\n", admission_failed);
    printf("  decode failures           %12llu\n", decode_failed);
    printf("templates rejected          %12llu / %u\n",
           rejected_templates, counts.template_count);
    printf("nodes                       %12llu\n", node_total);
    printf("  rejected                  %12llu\n", node_rejected);
    if (node_total)
        printf("  direct                    %12.2f%%\n",
               100.0 * (double)(node_total - node_rejected)
                     / (double)node_total);
    printf("\nrejected nodes by opcode\n");
    printf("  opcode        rejected        total  unsupported          abi        other\n");
    for (pl_u32 index = 0; index < PL_OPCODE_COUNT; ++index) {
        const opcode_row *row = &rows[index];
        if (!row->rejected) continue;
        printf("  %6u %15llu %12llu %12llu %12llu %12llu\n",
               row->opcode, row->rejected, row->total, row->unsupported,
               row->abi, row->other);
    }
    printf("\nwhole-block rejection status\n");
    for (pl_u32 index = 1u; index < 32u; ++index)
        if (block_status[index])
            printf("  %4d %-34s %12llu\n", -(int)index,
                   pl_error_name(-(int)index), block_status[index]);

    free(failed_template);
    free(arena_base);
    free(payload);
    return admission_failed || decode_failed ? 1 : 0;
}
