#include <postlink/compiler.h>
#include <optimized-x86/reader.h>
#include <support/checked.h>

#include "../src/internal/block.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    pl_u8 **bytes;
    pl_u32 *length;
    pl_u32 count;
    pl_u32 capacity;
    pl_u64 opened_bytes;
    pl_u64 retained_bytes;
} observed_classes;

typedef struct {
    pl_u8 *block_seen;
    pl_u64 *work_by_state;
    pl_u64 *span_by_state;
    pl_u32 states;
    pl_u32 blocks;
    pl_u64 expected_instructions;
    pl_u64 normal_instruction_bytes;
    pl_u64 work_lower_bound_sum;
    pl_u64 span_lower_bound_sum;
    pl_u32 work_histogram[16];
    pl_u32 span_histogram[16];
    pl_u64 maximum_work;
    pl_u64 maximum_span;
    pl_u32 minimum_proofs;
    observed_classes law;
    observed_classes binding;
    observed_classes control_law;
    observed_classes topology;
    observed_classes control_binding;
    observed_classes parameters;
    observed_classes node_law;
    pl_u64 node_occurrences;
    pl_u64 emitted_bytes;
    pl_u64 emitted_instructions;
    pl_u64 emitted_end;
    pl_u32 emitted_blocks;
    pl_u64 committed_elf_bytes;
    pl_u32 committed;
} observed_population;

static void classes_close(observed_classes *classes)
{
    if (!classes) return;
    for (pl_u32 rank = 0u; rank < classes->count; ++rank)
        free(classes->bytes[rank]);
    free(classes->length);
    free(classes->bytes);
    *classes = (observed_classes){ 0 };
}

static int classes_intern_rank(observed_classes *classes,
                               const pl_u8 *bytes, pl_u32 length,
                               pl_u32 *out_rank)
{
    if (!classes || !bytes || !length || !out_rank) return 0;
    classes->opened_bytes += length;
    for (pl_u32 rank = 0u; rank < classes->count; ++rank)
        if (classes->length[rank] == length
                && !memcmp(classes->bytes[rank], bytes, length)) {
            *out_rank = rank;
            return 1;
        }
    if (classes->count == classes->capacity) {
        pl_u32 capacity = classes->capacity ? classes->capacity * 2u : 16u;
        if (capacity < classes->capacity) return 0;
        pl_u8 **cell = realloc(
            classes->bytes, (size_t)capacity * sizeof(*cell));
        if (!cell) return 0;
        classes->bytes = cell;
        pl_u32 *extent = realloc(
            classes->length, (size_t)capacity * sizeof(*extent));
        if (!extent) return 0;
        classes->length = extent;
        classes->capacity = capacity;
    }
    pl_u8 *copy = malloc(length);
    if (!copy) return 0;
    memcpy(copy, bytes, length);
    classes->bytes[classes->count] = copy;
    classes->length[classes->count] = length;
    *out_rank = classes->count;
    ++classes->count;
    classes->retained_bytes += length;
    return 1;
}

static int classes_intern(observed_classes *classes,
                          const pl_u8 *bytes, pl_u32 length)
{
    pl_u32 rank = 0u;
    return classes_intern_rank(classes, bytes, length, &rank);
}

static int prefix(const pl_u8 *bytes, pl_u32 length,
                  const char tag[4])
{
    return bytes && length >= 5u
        && bytes[0] == (pl_u8)tag[0]
        && bytes[1] == (pl_u8)tag[1]
        && bytes[2] == (pl_u8)tag[2]
        && bytes[3] == (pl_u8)tag[3]
        && bytes[4] == 5u;
}

static int open_uleb64(const pl_u8 *bytes, pl_u32 length,
                       pl_u32 *at, pl_u64 *out)
{
    if (!bytes || !at || !out || *at >= length) return 0;
    pl_u32 start = *at;
    pl_u64 value = 0u;
    for (pl_u32 group = 0u; group < 10u; ++group) {
        if (*at >= length) return 0;
        pl_u8 byte = bytes[(*at)++];
        if (group == 9u && (byte & 0xfeu)) return 0;
        value |= (pl_u64)(byte & 0x7fu) << (group * 7u);
        if (!(byte & 0x80u)) {
            if (*at - start > 1u && !(byte & 0x7fu)) return 0;
            *out = value;
            return 1;
        }
    }
    return 0;
}

static int open_topology_operand(const pl_u8 *bytes, pl_u32 length,
                                 pl_u32 *at, pl_u8 *kind, pl_u64 *value)
{
    if (!bytes || !at || !kind || !value || *at >= length) return 0;
    *kind = bytes[(*at)++];
    *value = 0u;
    if (*kind >= PL_OPERAND_KINDS) return 0;
    if (PL_OPERAND_STAYS(*kind)) {
        if (length - *at < 8u) return 0;
        *value = pl_read_u64(bytes + *at);
        *at += 8u;
    }
    return 1;
}

static void put_u32(pl_u8 *target, pl_u32 value)
{
    target[0] = (pl_u8)value;
    target[1] = (pl_u8)(value >> 8u);
    target[2] = (pl_u8)(value >> 16u);
    target[3] = (pl_u8)(value >> 24u);
}

/* Reopen SSTP1 only in this diagnostic and quotient each node by its complete
 * predecessor laws. Raw node numbers and every lifted binding disappear. */
static int observe_node_laws(observed_population *population,
                             const pl_u8 *topology, pl_u32 length)
{
    if (!population || !topology || length < 5u
            || topology[0] != 'S' || topology[1] != 'S'
            || topology[2] != 'T' || topology[3] != 'P'
            || topology[4] != 1u)
        return 0;
    pl_u32 at = 5u;
    pl_u64 scalar[6];
    for (pl_u32 field = 0u; field < 6u; ++field)
        if (!open_uleb64(topology, length, &at, &scalar[field]))
            return 0;
    pl_u64 node_count64 = scalar[1];
    pl_u64 argument_count64 = scalar[2];
    pl_u64 stack_count64 = scalar[3];
    pl_u64 local_updates64 = scalar[5];
    if (node_count64 > 0xffffffffu || argument_count64 > 0xffffffffu
            || stack_count64 > 0xffffffffu
            || local_updates64 > 0xffffffffu)
        return 0;
    pl_u32 node_count = (pl_u32)node_count64;
    pl_u32 argument_count = (pl_u32)argument_count64;
    pl_u32 *arity = malloc(
        (size_t)(node_count ? node_count : 1u) * sizeof(*arity));
    pl_u32 *node_class = malloc(
        (size_t)(node_count ? node_count : 1u) * sizeof(*node_class));
    pl_u8 *opcode = malloc(node_count ? node_count : 1u);
    if (!arity || !node_class || !opcode) {
        free(opcode); free(node_class); free(arity);
        return 0;
    }
    pl_u64 counted_arguments = 0u;
    for (pl_u32 node = 0u; node < node_count; ++node) {
        pl_u64 count = 0u;
        if (at >= length) goto fail;
        opcode[node] = topology[at++];
        if (!open_uleb64(topology, length, &at, &count)
                || count > 0xffffffffu
                || counted_arguments > 0xffffffffu - count)
            goto fail;
        arity[node] = (pl_u32)count;
        counted_arguments += count;
    }
    if (counted_arguments != argument_count) goto fail;
    for (pl_u32 node = 0u; node < node_count; ++node) {
        pl_u64 maximum = 5u + (pl_u64)arity[node] * 6u;
        if (maximum > (size_t)-1 || maximum > 0xffffffffu) goto fail;
        pl_u8 *signature = malloc((size_t)maximum);
        if (!signature) goto fail;
        pl_u32 used = 0u;
        signature[used++] = opcode[node];
        put_u32(signature + used, arity[node]);
        used += 4u;
        for (pl_u32 slot = 0u; slot < arity[node]; ++slot) {
            pl_u8 kind = 0u;
            pl_u64 value = 0u;
            if (!open_topology_operand(
                    topology, length, &at, &kind, &value)) {
                free(signature);
                goto fail;
            }
            signature[used++] = kind;
            if (PL_OPERAND_STAYS(kind)) {
                pl_u64 source = kind == PL_OPERAND_PROJECTION
                              ? value >> 8u : value;
                pl_u32 selector = kind == PL_OPERAND_PROJECTION
                                ? (pl_u32)(value & 0xffu) : 0u;
                if (!source || source > node) {
                    free(signature);
                    goto fail;
                }
                put_u32(signature + used, node_class[source - 1u]);
                used += 4u;
                if (kind == PL_OPERAND_PROJECTION)
                    signature[used++] = (pl_u8)selector;
            }
        }
        int interned = classes_intern_rank(
            &population->node_law, signature, used, &node_class[node]);
        free(signature);
        if (!interned) goto fail;
        ++population->node_occurrences;
    }
    for (pl_u64 output = 0u;
            output < stack_count64 + local_updates64; ++output) {
        pl_u8 kind = 0u;
        pl_u64 value = 0u;
        if (!open_topology_operand(
                topology, length, &at, &kind, &value))
            goto fail;
    }
    free(opcode); free(node_class); free(arity);
    return at == length;
fail:
    free(opcode); free(node_class); free(arity);
    return 0;
}

static int observe_begin(void *opaque, pl_u32 states, pl_u32 arms,
                         pl_u64 source_instructions)
{
    observed_population *population = opaque;
    pl_u8 *seen;
    if (!population || !states || arms != 2u || !source_instructions)
        return -1;
    seen = realloc(population->block_seen, (size_t)states);
    if (!seen) return -1;
    pl_u64 *work_by_state = realloc(
        population->work_by_state, (size_t)states * sizeof *work_by_state);
    if (!work_by_state) return -1;
    population->work_by_state = work_by_state;
    pl_u64 *span_by_state = realloc(
        population->span_by_state, (size_t)states * sizeof *span_by_state);
    if (!span_by_state) return -1;
    population->span_by_state = span_by_state;
    memset(seen, 0, (size_t)states);
    memset(population->work_by_state, 0,
           (size_t)states * sizeof *population->work_by_state);
    memset(population->span_by_state, 0,
           (size_t)states * sizeof *population->span_by_state);
    population->block_seen = seen;
    population->states = states;
    population->blocks = 0u;
    population->expected_instructions = source_instructions;
    population->normal_instruction_bytes = 0u;
    population->work_lower_bound_sum = 0u;
    population->span_lower_bound_sum = 0u;
    memset(population->work_histogram, 0,
           sizeof population->work_histogram);
    memset(population->span_histogram, 0,
           sizeof population->span_histogram);
    population->maximum_work = 0u;
    population->maximum_span = 0u;
    population->minimum_proofs = 0u;
    classes_close(&population->law);
    classes_close(&population->binding);
    classes_close(&population->control_law);
    classes_close(&population->topology);
    classes_close(&population->control_binding);
    classes_close(&population->parameters);
    classes_close(&population->node_law);
    population->node_occurrences = 0u;
    population->emitted_bytes = 0u;
    population->emitted_instructions = 0u;
    population->emitted_end = 0u;
    population->emitted_blocks = 0u;
    population->committed = 0u;
    population->committed_elf_bytes = 0u;
    return 0;
}

static int observe_block(
    void *opaque, pl_u32 state,
    const pl_u8 *instruction, pl_u32 instruction_bytes,
    const pl_u32 successor[2])
{
    observed_population *population = opaque;
    pl_u32 body_at = 7u;
    pl_u64 work = 0u, span = 0u;
    pl_u64 law_bytes64 = 0u, binding_bytes64 = 0u;
    int header = prefix(instruction, instruction_bytes, "X86N")
        && instruction_bytes >= 11u && instruction[5] == 2u
        && instruction[6] == 7u
        && open_uleb64(instruction, instruction_bytes, &body_at, &work)
        && open_uleb64(instruction, instruction_bytes, &body_at, &span)
        && open_uleb64(
            instruction, instruction_bytes, &body_at, &law_bytes64)
        && open_uleb64(
            instruction, instruction_bytes, &body_at, &binding_bytes64)
        && law_bytes64 && law_bytes64 <= 0xffffffffu
        && binding_bytes64 && binding_bytes64 <= 0xffffffffu
        && (pl_u64)body_at + law_bytes64 + binding_bytes64
           == instruction_bytes;
    pl_u32 law_bytes = header ? (pl_u32)law_bytes64 : 0u;
    pl_u32 binding_bytes = header ? (pl_u32)binding_bytes64 : 0u;
    const pl_u8 *law = header ? instruction + body_at : 0;
    const pl_u8 *binding = header ? law + law_bytes : 0;
    pl_u32 control_law_bytes = law_bytes >= 13u
        ? pl_read_u32(law + 5u) : 0u;
    pl_u32 topology_bytes = law_bytes >= 13u
        ? pl_read_u32(law + 9u) : 0u;
    pl_u32 control_binding_bytes = binding_bytes >= 13u
        ? pl_read_u32(binding + 5u) : 0u;
    pl_u32 parameter_bytes = binding_bytes >= 13u
        ? pl_read_u32(binding + 9u) : 0u;
    int components = law && binding
        && law[0] == 'X' && law[1] == '8' && law[2] == '6'
        && law[3] == 'L' && law[4] == 1u
        && binding[0] == 'X' && binding[1] == '8' && binding[2] == '6'
        && binding[3] == 'B' && binding[4] == 2u
        && control_law_bytes && topology_bytes
        && control_binding_bytes && parameter_bytes
        && (pl_u64)13u + control_law_bytes + topology_bytes == law_bytes
        && (pl_u64)13u + control_binding_bytes + parameter_bytes
           == binding_bytes;
    if (!population || state >= population->states
            || population->block_seen[state]
            || !header || !components
            || !successor || successor[0] >= population->states
            || successor[1] >= population->states
            || !classes_intern(
                &population->law, instruction + body_at, law_bytes)
            || !classes_intern(
                &population->binding,
                binding, binding_bytes)
            || !classes_intern(
                &population->control_law, law + 13u, control_law_bytes)
            || !classes_intern(
                &population->topology,
                law + 13u + control_law_bytes, topology_bytes)
            || !classes_intern(
                &population->control_binding,
                binding + 13u, control_binding_bytes)
            || !classes_intern(
                &population->parameters,
                binding + 13u + control_binding_bytes, parameter_bytes)
            || !observe_node_laws(
                population, law + 13u + control_law_bytes,
                topology_bytes))
        return -1;
    population->block_seen[state] = 1u;
    ++population->blocks;
    ++population->minimum_proofs;
    population->normal_instruction_bytes += instruction_bytes;
    population->work_by_state[state] = work;
    population->span_by_state[state] = span;
    population->work_lower_bound_sum += work;
    population->span_lower_bound_sum += span;
    ++population->work_histogram[work < 15u ? (pl_u32)work : 15u];
    ++population->span_histogram[span < 15u ? (pl_u32)span : 15u];
    if (work > population->maximum_work) population->maximum_work = work;
    if (span > population->maximum_span) population->maximum_span = span;
    return 0;
}

static int observe_commit(void *opaque,
                          const pl_u8 *optimized_elf,
                          pl_u64 optimized_elf_bytes)
{
    observed_population *population = opaque;
    if (!population || population->blocks != population->states
            || population->emitted_blocks != population->states
            || !optimized_elf || !optimized_elf_bytes)
        return -1;
    population->committed = 1u;
    population->committed_elf_bytes = optimized_elf_bytes;
    return 0;
}

static int observe_emitted(
    void *opaque, pl_u32 state, pl_u64 file_offset,
    const pl_u8 *bytes, pl_u32 byte_count)
{
    observed_population *population = opaque;
    if (!population || state != population->emitted_blocks
            || state >= population->states || !bytes
            || (state && file_offset != population->emitted_end)
            || file_offset > 0xffffffffffffffffull - byte_count)
        return -1;
    if (byte_count) {
        const pl_u64 base = 0x100000000ull;
        pl_x86_map map = {
            bytes, base, byte_count, byte_count,
            PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
        };
        pl_x86_image image = { &map, 1u, 0u, base };
        pl_x86_frontend frontend;
        pl_u32 state_instructions = 0u;
        pl_u32 state_operation[16];
        if (pl_x86_frontend_open(&image, &frontend)) return -1;
        pl_u64 rip = base;
        while (rip < base + byte_count) {
            pl_x86_instruction decoded;
            if (pl_x86_frontend_decode(&frontend, rip, &decoded)
                    || !decoded.source_bytes
                    || decoded.fallthrough <= rip
                    || decoded.fallthrough > base + byte_count) {
                fprintf(stderr,
                        "emitted decode RED: state=%u at=%llu bytes=%u:",
                        state, (unsigned long long)(rip - base), byte_count);
                for (pl_u32 byte = 0u; byte < byte_count; ++byte)
                    fprintf(stderr, "%02x", (unsigned)bytes[byte]);
                fputc('\n', stderr);
                return -1;
            }
            ++population->emitted_instructions;
            if (state_instructions < 16u)
                state_operation[state_instructions] = decoded.operation;
            ++state_instructions;
            rip = decoded.fallthrough;
        }
        if (rip != base + byte_count) return -1;
        if (population->work_by_state[state] > 1u) {
            printf("  state %u minimum=%llu/%llu emitted=%u bytes=",
                   state,
                   (unsigned long long)population->work_by_state[state],
                   (unsigned long long)population->span_by_state[state],
                   state_instructions);
            for (pl_u32 byte = 0u; byte < byte_count; ++byte)
                printf("%02x", (unsigned)bytes[byte]);
            printf(" operations:");
            for (pl_u32 instruction = 0u;
                    instruction < state_instructions && instruction < 16u;
                    ++instruction)
                printf(" op%u", state_operation[instruction]);
            printf("\n");
        }
    }
    population->emitted_end = file_offset + byte_count;
    population->emitted_bytes += byte_count;
    ++population->emitted_blocks;
    return 0;
}

static int read_file(const char *path, pl_u8 **bytes, pl_u64 *length)
{
    FILE *file = fopen(path, "rb");
    long end;
    if (!file || fseek(file, 0, SEEK_END)) return 0;
    end = ftell(file);
    if (end <= 0 || fseek(file, 0, SEEK_SET)) {
        fclose(file);
        return 0;
    }
    *bytes = malloc((size_t)end);
    if (!*bytes || fread(*bytes, 1u, (size_t)end, file) != (size_t)end) {
        free(*bytes);
        *bytes = 0;
        fclose(file);
        return 0;
    }
    if (fclose(file)) return 0;
    *length = (pl_u64)(unsigned long)end;
    return 1;
}

int main(int argc, char **argv)
{
    pl_u8 *input = 0, *output = 0, *workspace = 0;
    pl_u64 input_bytes = 0u, output_bytes = 0u;
    postlink_measurement measurement;
    postlink_report report;
    observed_population population = { 0 };
    postlink_observer observer = {
        &population, observe_begin, observe_block,
        observe_emitted, observe_commit,
    };
    int status;
    if (argc != 2 || !read_file(argv[1], &input, &input_bytes)) return 2;
    status = postlink_measure(input, input_bytes, &measurement, &report);
    if (!status && (measurement.output_capacity > (pl_u64)(size_t)-1
            || measurement.workspace_bytes > (pl_u64)(size_t)-1))
        status = POSTLINK_ERROR_WORKSPACE;
    output = status ? 0 : malloc((size_t)measurement.output_capacity);
    workspace = status ? 0 : malloc((size_t)measurement.workspace_bytes);
    if (!status && (!output || !workspace)) status = POSTLINK_ERROR_WORKSPACE;
    for (;;) {
        if (status) break;
        status = postlink_compile_observed(
            input, input_bytes, output, measurement.output_capacity,
            &output_bytes, workspace, measurement.workspace_bytes,
            &observer, &report);
        if (status != POSTLINK_ERROR_WORKSPACE
                || report.required_workspace_bytes
                   <= measurement.workspace_bytes)
            break;
        if (report.required_workspace_bytes > (pl_u64)(size_t)-1) break;
        pl_u8 *larger = realloc(
            workspace, (size_t)report.required_workspace_bytes);
        if (!larger) break;
        workspace = larger;
        measurement.workspace_bytes = report.required_workspace_bytes;
        status = 0;
    }
    ox_image opened;
    if (!status) status = ox_image_open(output, output_bytes, &opened);
    if (!status && (!population.committed
            || population.blocks != population.states
            || population.states != report.native_blocks
            || population.expected_instructions
               != report.native_source_instructions
            || population.emitted_blocks != population.states
            || population.emitted_bytes != report.output_code_bytes
            || population.emitted_instructions
               != population.work_lower_bound_sum
            || population.committed_elf_bytes != output_bytes
            || !population.normal_instruction_bytes
            || population.minimum_proofs != population.states
            || !population.law.count
            || population.law.count >= population.states
            || !population.binding.count
            || !population.control_law.count
            || !population.topology.count
            || !population.control_binding.count
            || !population.parameters.count
            || !population.node_law.count
            || population.node_law.count > population.node_occurrences
            || population.law.opened_bytes < population.law.retained_bytes
            || population.binding.opened_bytes
               < population.binding.retained_bytes
            || output_bytes >= input_bytes))
        status = POSTLINK_ERROR_INCOMPLETE;
    if (status) {
        fprintf(stderr,
                "observed compile: RED (%s; proof=%u stage=%u sub=%d need=%llu "
                "have=%llu blocks=%u/%u, instructions=%llu/%llu, "
                "law/topology/binding/node=%u/%u/%u/%u)\n",
                postlink_status_string(status), report.proof_stage,
                report.native_failure_stage,
                report.native_failure_status,
                (unsigned long long)report.native_failure_output,
                (unsigned long long)report.native_failure_expected,
                population.blocks, population.states,
                (unsigned long long)population.expected_instructions,
                (unsigned long long)population.expected_instructions,
                population.law.count, population.topology.count,
                population.binding.count, population.node_law.count);
    } else {
        printf("observed compile: green (%u blocks -> %u SSA-law classes "
               "[%u control x %u topology] + %u binding classes "
               "[%u control x %u parameter]; %llu semantic SSA nodes -> "
               "%u node laws; %llu emitted x86 instructions, "
               "%llu source instructions; "
               "proved work*/span*=%llu/%llu; law %llu -> %llu bytes; "
               "%llu -> %llu ELF bytes)\n",
               population.blocks,
               population.law.count, population.control_law.count,
               population.topology.count, population.binding.count,
               population.control_binding.count,
               population.parameters.count,
               (unsigned long long)population.node_occurrences,
               population.node_law.count,
               (unsigned long long)population.emitted_instructions,
               (unsigned long long)population.expected_instructions,
               (unsigned long long)population.work_lower_bound_sum,
               (unsigned long long)population.span_lower_bound_sum,
               (unsigned long long)population.law.opened_bytes,
               (unsigned long long)population.law.retained_bytes,
               (unsigned long long)input_bytes,
               (unsigned long long)output_bytes);
        printf("block minimum histogram (work/span; max=%llu/%llu):",
               (unsigned long long)population.maximum_work,
               (unsigned long long)population.maximum_span);
        for (pl_u32 cost = 0u; cost < 16u; ++cost)
            if (population.work_histogram[cost]
                    || population.span_histogram[cost])
                printf(" %u%s=%u/%u", cost, cost == 15u ? "+" : "",
                       population.work_histogram[cost],
                       population.span_histogram[cost]);
        printf("\n");
        printf("RFLAGS future projection: %u dead, %u emitted, "
               "%u selector-boundary (%u grew, %u escape, "
               "%u source-identity, %u changed-output)\n",
               report.native_rflags_dead_blocks,
               report.native_rflags_projected_blocks,
               report.native_rflags_projection_grammar_blocks,
               report.native_rflags_projection_grew_blocks,
               report.native_rflags_projection_escape_blocks,
               report.native_rflags_projection_source_identity_blocks,
               report.native_rflags_projection_changed_grammar_blocks);
        printf("RFLAGS selector first: grammar=%llx grew=%llx escape=%llx "
               "changed=%llx\n",
               (unsigned long long)
                   report.native_first_rflags_projection_grammar_address,
               (unsigned long long)
                   report.native_first_rflags_projection_grew_address,
               (unsigned long long)
                   report.native_first_rflags_projection_escape_address,
               (unsigned long long)
                   report.native_first_rflags_projection_changed_grammar_address);
    }
    classes_close(&population.node_law);
    classes_close(&population.parameters);
    classes_close(&population.control_binding);
    classes_close(&population.topology);
    classes_close(&population.control_law);
    classes_close(&population.binding);
    classes_close(&population.law);
    free(population.block_seen);
    free(population.span_by_state);
    free(population.work_by_state);
    free(workspace);
    free(output);
    free(input);
    return status ? 1 : 0;
}
