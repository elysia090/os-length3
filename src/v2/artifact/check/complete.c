#include <artifact/complete.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define OBS(family_, domain_, response_) { \
    (family_), (const pl_u8 *)(domain_), \
    (pl_u32)(sizeof(domain_) - 1u), (const pl_u8 *)(response_), \
    (pl_u32)(sizeof(response_) - 1u) }
#define PAYLOAD(text) { (const pl_u8 *)(text), \
                        (pl_u32)(sizeof(text) - 1u) }
#define CELL(text) { (const pl_u8 *)(text), (pl_u32)(sizeof(text) - 1u) }
#define NORMAL_CELL(law) { \
    'X','8','6','N', 5u,2u,7u, 1u,1u,1u,1u, law,'B' \
}

typedef struct {
    artifact_complete_workspace value;
    void *allocation[64];
    pl_u32 allocations;
} owned_workspace;

static void *take(owned_workspace *workspace, size_t bytes)
{
    void *value = malloc(bytes ? bytes : 1u);
    if (value && workspace->allocations
            < sizeof(workspace->allocation) / sizeof(workspace->allocation[0]))
        workspace->allocation[workspace->allocations++] = value;
    return value;
}

static void release(owned_workspace *workspace)
{
    while (workspace->allocations)
        free(workspace->allocation[--workspace->allocations]);
}

static int allocate_rank_map(pl_u32 occurrences, owned_workspace *owner,
                             artifact_rank_map_workspace *out)
{
    pl_u32 padded = 0u, scratch_bytes = 0u;
    pl_u32 node_capacity = 0u, level_capacity = 0u;
    int status = artifact_rank_map_measure(
        occurrences, &padded, &scratch_bytes,
        &node_capacity, &level_capacity);
    pl_u32 *observation = status ? 0 : take(
        owner, (size_t)padded * sizeof(*observation));
    pl_u8 *scratch = status ? 0 : take(owner, scratch_bytes);
    pl_u32 *children = status ? 0 : take(
        owner, (size_t)node_capacity * 2u * sizeof(*children));
    pl_u32 *levels = status ? 0 : take(
        owner, (size_t)level_capacity * sizeof(*levels));
    *out = (artifact_rank_map_workspace){
        observation, padded,
        { scratch, scratch_bytes, children,
          children ? children + node_capacity : 0,
          node_capacity, levels, level_capacity },
    };
    return !status && (!observation || !scratch || !children || !levels)
         ? ARTIFACT_ERROR_COMPLETE_RANGE : status;
}

static int allocate_share(pl_u32 occurrences, owned_workspace *owner,
                          artifact_share_workspace *out)
{
    pl_u32 digest_bytes = 0u, indices = 0u;
    int status = artifact_share_measure(
        occurrences, &digest_bytes, &indices);
    pl_u8 *digest = status ? 0 : take(owner, digest_bytes);
    pl_u32 *index = status ? 0 : take(
        owner, (size_t)indices * 4u * sizeof(*index));
    *out = (artifact_share_workspace){
        digest, digest_bytes, index,
        index ? index + indices : 0,
        index ? index + indices * 2u : 0,
        index ? index + indices * 3u : 0,
        indices,
    };
    return !status && (!digest || !index)
         ? ARTIFACT_ERROR_COMPLETE_RANGE : status;
}

static int allocate(const artifact_complete_population *population,
                    owned_workspace *out)
{
    int status = 0;
    if (population->archive_semantic_occurrences)
        status = allocate_share(
            population->archive_semantic_occurrences, out,
            &out->value.archive_semantic);

    const artifact_program_population *program = population->program;
    pl_u32 states = program ? program->states : 0u;
    artifact_complete_observation *program_observation = status ? 0 : take(
        out, (size_t)states * sizeof(*program_observation));
    if (!status)
        status = allocate_share(
            states, out, &out->value.program.future.immediate);
    pl_u32 future_bytes = 0u;
    if (!status)
        status = pl_finite_future_workspace_measure(
            states, program->arms, &future_bytes);
    pl_u32 *future_rank = status ? 0 : take(
        out, (size_t)states * sizeof(*future_rank));
    pl_u8 *future_scratch = status ? 0 : take(out, future_bytes);
    out->value.program.observation = program_observation;
    out->value.program.state_capacity = states;
    out->value.program.future.future = (pl_finite_future_workspace){
        future_rank, states, future_scratch, future_bytes,
    };
    if (!status)
        status = allocate_rank_map(
            states, out,
            &out->value.block_future_rank);

    pl_u32 payload_digest_bytes = 0u, payload_indices = 0u;
    if (!status)
        status = artifact_share_measure(
            population->payload_occurrences,
            &payload_digest_bytes, &payload_indices);
    pl_u8 *payload_digest = status ? 0 : take(out, payload_digest_bytes);
    pl_u32 *payload_index = status ? 0 : take(
        out, (size_t)payload_indices * 4u * sizeof(*payload_index));
    artifact_complete_observation *payload_observation = status ? 0 : take(
        out, (size_t)population->payload_occurrences
            * sizeof(*payload_observation));
    out->value.payload = (artifact_payload_workspace){
        payload_observation, population->payload_occurrences,
        { payload_digest, payload_digest_bytes, payload_index,
          payload_index ? payload_index + payload_indices : 0,
          payload_index ? payload_index + payload_indices * 2u : 0,
          payload_index ? payload_index + payload_indices * 3u : 0,
          payload_indices },
    };
    out->value.archive.payload = out->value.payload;
    pl_u32 maximum_archive_members = 0u;
    pl_u32 maximum_archive_bytes = 0u;
    for (pl_u32 archive = 0u; !status && archive < population->archive_count;
            ++archive) {
        const artifact_archive_instance *instance =
            &population->archives[archive];
        if (instance->view.member_count > maximum_archive_members)
            maximum_archive_members = instance->view.member_count;
        if (instance->canonical_byte_count > maximum_archive_bytes)
            maximum_archive_bytes = instance->canonical_byte_count;
    }
    out->value.archive.member_header = status ? 0 : take(
        out, (size_t)maximum_archive_members
            * sizeof(*out->value.archive.member_header));
    out->value.archive.long_name_offset = status ? 0 : take(
        out, (size_t)maximum_archive_members
            * sizeof(*out->value.archive.long_name_offset));
    out->value.archive.member_capacity = maximum_archive_members;
    out->value.archive.generated = status ? 0 : take(
        out, maximum_archive_bytes);
    out->value.archive.generated_capacity = maximum_archive_bytes;
    if (!status)
        status = allocate_rank_map(
            population->payload_occurrences, out,
            &out->value.payload_rank);

    pl_u32 support_bytes = 0u, derive_digest_bytes = 0u;
    pl_u32 derive_indices = 0u;
    if (!status)
        status = artifact_derive_measure(
            population->cell_coordinates, &support_bytes,
            &derive_digest_bytes, &derive_indices);
    pl_u8 *support = status ? 0 : take(out, support_bytes);
    pl_u8 *derive_digest = status ? 0 : take(out, derive_digest_bytes);
    pl_u32 *derive_index = status ? 0 : take(
        out, (size_t)derive_indices * 7u * sizeof(*derive_index));
    artifact_complete_observation *derive_observation = status ? 0 : take(
        out, (size_t)derive_indices * sizeof(*derive_observation));
    out->value.derived = (artifact_derive_workspace){
        support, support_bytes, derive_index,
        derive_index ? derive_index + derive_indices : 0,
        derive_index ? derive_index + derive_indices * 2u : 0,
        derive_observation,
        { derive_digest, derive_digest_bytes,
          derive_index ? derive_index + derive_indices * 3u : 0,
          derive_index ? derive_index + derive_indices * 4u : 0,
          derive_index ? derive_index + derive_indices * 5u : 0,
          derive_index ? derive_index + derive_indices * 6u : 0,
          derive_indices },
        derive_indices,
    };

    pl_u64 word_bytes = 0u;
    for (pl_u32 index = 0u;
            !status && index < population->payload_occurrences; ++index) {
        if (word_bytes > 0xffffffffull
                - population->payloads[index].length)
            status = ARTIFACT_ERROR_COMPLETE_RANGE;
        else
            word_bytes += population->payloads[index].length;
    }
    pl_u32 word_capacity = (pl_u32)word_bytes;
    pl_u32 vector = 0u, tree = 0u;
    if (!status)
        status = artifact_factor_index_measure(
            word_capacity, &vector, &tree);
    pl_u32 *factor_vector = status ? 0 : take(
        out, (size_t)vector * 4u * sizeof(*factor_vector));
    pl_u64 *cost_tree = status ? 0 : take(
        out, (size_t)tree * sizeof(*cost_tree));
    out->value.factor = (artifact_factor_index_workspace){
        .source = factor_vector ? factor_vector + vector * 2u : 0,
        .length = factor_vector ? factor_vector + vector * 3u : 0,
        .suffix_array = factor_vector,
        .rank = factor_vector ? factor_vector + vector : 0,
        .vector_capacity = vector,
        .cost_tree = cost_tree,
        .tree_capacity = tree,
    };
    pl_u32 factor_code_capacity = word_capacity
        ? (pl_u32)(((pl_u64)word_capacity * 9u + 7u) >> 3u) : 0u;
    if (!status && !factor_code_capacity)
        status = ARTIFACT_ERROR_COMPLETE_RANGE;
    out->value.factor_code = status ? 0 : take(out, factor_code_capacity);
    out->value.factor_code_capacity = factor_code_capacity;
    out->value.payload_end = status ? 0 : take(
        out, (size_t)population->payload_occurrences
            * sizeof(*out->value.payload_end));
    out->value.payload_end_capacity = population->payload_occurrences;

    if (!status && (!program_observation || !future_rank || !future_scratch
            || !payload_digest || !payload_index || !payload_observation
            || (population->archive_count
                && (!out->value.archive.member_header
                    || !out->value.archive.long_name_offset
                    || !out->value.archive.generated))
            || !support || !derive_digest || !derive_index
            || !derive_observation || !factor_vector
            || !cost_tree
            || !out->value.factor_code || !out->value.payload_end))
        status = ARTIFACT_ERROR_COMPLETE_RANGE;
    return status;
}

int main(void)
{
    /* The equal block pair deliberately represents two linked ELFs.  Source
     * spelling and address are absent from the total response, so one rank is
     * both necessary and sufficient. */
    pl_u8 archive_semantic_response[128];
    pl_u8 archive_symbol_response[21];
    pl_u8 archive_member_material[64];
    pl_u8 archive_symbol_material[64];
    artifact_complete_observation archive_semantic[] = {
        OBS(ARTIFACT_OBSERVATION_ARCHIVE_MEMBER,
            "gnu-ar-member-view-v1", "placeholder-archive"),
        OBS(ARTIFACT_OBSERVATION_ARCHIVE_MEMBER,
            "gnu-ar-symbol-view-v1", "placeholder-symbol"),
    };
    pl_u8 namespace_descriptor[64] = { 0 };
    artifact_payload payloads[] = {
        PAYLOAD("ELF-A:shared-rodata-tail"),
        PAYLOAD("ELF-A:shared-rodata-tail"),
        PAYLOAD("archive:shared-rodata-tail"),
        PAYLOAD("shared-rodata"),
        PAYLOAD("proof:shared-rodata-tail"),
        { archive_member_material, 5u + 8u + 8u },
        { archive_symbol_material, 5u + 8u + 13u },
        PAYLOAD("exception-A"),
        PAYLOAD("namespace-topology"),
        PAYLOAD("namespace-inode"),
    };
    static const artifact_cell actual[] = {
        CELL("proof(source,optimized)"),
        CELL("offset[17]=4096"),
        CELL("directory(alpha)=rank-3"),
        CELL("exception-A"),
        CELL("exception-A"),
    };
    static const artifact_cell generated[] = {
        CELL("proof(source,optimized)"),
        CELL("offset[17]=4096"),
        CELL("directory(alpha)=rank-3"),
        CELL("predicted-A"),
        CELL("predicted-A"),
    };
    enum {
        SEMANTIC_COUNT = 2u + 0u + 0u + 10u + 2u + 2u,
        PAYLOAD_COUNT = sizeof(payloads) / sizeof(payloads[0]),
        CELL_COUNT = sizeof(actual) / sizeof(actual[0]),
    };
    static const pl_u8 normal_move[] = NORMAL_CELL('M');
    static const artifact_cell program_instruction[] = {
        { normal_move, (pl_u32)sizeof(normal_move) },
        { normal_move, (pl_u32)sizeof(normal_move) },
    };
    static const pl_u32 block_successor[] = { 0u, 0u, 1u, 1u };
    static const artifact_program_population program = {
        .instruction = program_instruction,
        .successor = block_successor,
        .states = 2u,
        .arms = 2u,
    };
    static const artifact_namespace_inode namespace_inode[] = {
        { ARTIFACT_NAMESPACE_DIRECTORY, ARTIFACT_NAMESPACE_NO_CONTENT,
          0u, 0755u, 0u, 0u, 0u, 0, 0u, 0, 0u },
    };
    static const artifact_namespace_path namespace_path[] = {
        { 0, 0u, 0u },
    };
    static const artifact_namespace_population namespace_population = {
        namespace_path, 1u, namespace_inode, 1u,
    };
    artifact_archive_member archive_member = {
        (const pl_u8 *)"shared.o", 8u, 0644u,
        payloads[2].bytes, payloads[2].length,
    };
    static const pl_u8 archive_symbol_name[] = "shared_symbol";
    artifact_archive_symbol archive_symbol = {
        archive_symbol_name, sizeof(archive_symbol_name) - 1u, 0u,
    };
    artifact_archive_view archive_view = {
        &archive_member, 1u, &archive_symbol, 1u,
    };
    pl_u64 archive_member_header[1];
    pl_u32 archive_long_name[1];
    pl_u8 archive_bytes[256];
    pl_u32 archive_byte_count = 0u;
    artifact_archive_workspace archive_writer = {
        archive_member_header, archive_long_name, 1u,
    };
    static const pl_u32 archive_member_occurrence[] = { 2u };
    artifact_archive_instance archive_instance = {
        .view = archive_view,
        .member_payload_occurrence = archive_member_occurrence,
        .canonical_bytes = archive_bytes,
    };
    int status = artifact_archive_write(
        &archive_view, &archive_writer,
        archive_bytes, (pl_u32)sizeof(archive_bytes), &archive_byte_count);
    archive_instance.canonical_byte_count = archive_byte_count;
    artifact_complete_population population = {
        .required_semantic_family_mask = 0x3fu,
        .required_semantic_occurrences = {
            2u, 0u, 0u, PAYLOAD_COUNT, 2u, 2u,
        },
        .program = &program,
        .required_program_instruction_classes = 1u,
        .required_program_future_classes = 1u,
        .payloads = payloads,
        .payload_occurrences = PAYLOAD_COUNT,
        .required_payload_occurrences = PAYLOAD_COUNT,
        .payload_projection = 0,
        .archives = &archive_instance,
        .archive_count = 1u,
        .required_archive_count = 1u,
        .required_archive_members = 1u,
        .required_archive_symbols = 1u,
        .archive_semantic = archive_semantic,
        .archive_semantic_occurrences = 2u,
        .archive_member_payload_base = 2u,
        .namespace_projection = 0,
        .required_namespace_paths = 1u,
        .required_namespace_inodes = 1u,
        .actual_cells = actual,
        .generated_cells = generated,
        .cell_coordinates = CELL_COUNT,
        .required_cell_coordinates = CELL_COUNT,
    };
    owned_workspace workspace = { 0 };
    if (!status) status = allocate(&population, &workspace);
    artifact_payload namespace_material[2];
    pl_u32 namespace_first_path[1];
    pl_u32 namespace_alias_path[1], namespace_alias_inode[1];
    workspace.value.namespace_workspace =
        (artifact_namespace_workspace){
            namespace_material, 2u,
            namespace_descriptor, sizeof(namespace_descriptor),
            namespace_first_path, 1u,
            namespace_alias_path, namespace_alias_inode, 1u,
        };
    artifact_namespace_projection namespace_projection = { 0 };
    if (!status)
        status = artifact_namespace_project(
            &namespace_population, &workspace.value.namespace_workspace,
            &namespace_projection);
    if (!status)
        population.namespace_projection = &namespace_projection;
    if (!status && namespace_projection.material_occurrences != 2u)
        status = ARTIFACT_ERROR_COMPLETE;
    for (pl_u32 material = 0u;
            !status && material < namespace_projection.material_occurrences;
            ++material)
        payloads[8u + material] = namespace_material[material];
    if (!status) {
        pl_u32 member_response_bytes = 0u;
        status = artifact_archive_member_response_write(
            &archive_member, archive_semantic_response,
            sizeof(archive_semantic_response), &member_response_bytes);
        archive_semantic[0].response = archive_semantic_response;
        archive_semantic[0].response_bytes = member_response_bytes;
        pl_u32 symbol_response_bytes = 0u;
        if (!status)
            status = artifact_archive_symbol_response_write(
                &archive_symbol, archive_symbol_response,
                sizeof(archive_symbol_response), &symbol_response_bytes);
        archive_semantic[1].response = archive_symbol_response;
        archive_semantic[1].response_bytes = symbol_response_bytes;

        pl_u32 member_material_bytes = 0u, symbol_material_bytes = 0u;
        status = artifact_archive_member_material_write(
            &archive_member, archive_member_material,
            sizeof(archive_member_material), &member_material_bytes);
        if (!status)
            status = artifact_archive_symbol_material_write(
                &archive_symbol, archive_symbol_material,
                sizeof(archive_symbol_material), &symbol_material_bytes);
        if (!status && (member_material_bytes != payloads[5].length
                || symbol_material_bytes != payloads[6].length))
            status = ARTIFACT_ERROR_COMPLETE;
    }
    artifact_payload_projection payload_projection = { 0 };
    if (!status)
        status = artifact_payload_project(
            payloads, PAYLOAD_COUNT, &workspace.value.payload,
            &payload_projection);
    if (!status)
        population.payload_projection = &payload_projection;
    artifact_complete_projection projection = { 0 };
    if (!status)
        status = artifact_complete_project(
            &population, &workspace.value, &projection);
    if (!status && (projection.semantic_family_mask != 0x3fu
            || projection.semantic_family_occurrences[0] != 2u
            || projection.semantic_family_occurrences[1]
            || projection.semantic_family_occurrences[2]
            || projection.semantic_family_occurrences[3] != PAYLOAD_COUNT
            || projection.semantic_family_occurrences[4] != 2u
            || projection.semantic_family_occurrences[5] != 2u
            || projection.semantic.occurrences != SEMANTIC_COUNT
            || projection.semantic.classes != 13u
            || projection.semantic.generated_rank_cells != SEMANTIC_COUNT
            || projection.semantic.retained_rank_cells
            || projection.program.future.future.classes != 1u
            || projection.program.instruction_classes != 1u
            || projection.block_future.future.classes != 1u
            || projection.block_future.shared_state_occurrences != 1u
            || projection.payload.classes != 9u
            || projection.payload.duplicate_bytes_eliminated
                != payloads[0].length
            || projection.archive.archives != 1u
            || projection.archive.members != 1u
            || projection.archive.symbols != 1u
            || projection.archive.removed_archive_bytes
               != archive_byte_count
            || projection.derived.generated_cells != 3u
            || projection.derived.exception_cells != 2u
            || projection.derived.exception_classes != 1u
            || !projection.factor.reference_tokens
            || !projection.factor.referenced_bytes
            || projection.factor.unresolved_bit_gap
            || projection.factor_code.payload_bits
               != projection.factor.retained_bits))
        status = ARTIFACT_ERROR_COMPLETE;

    artifact_complete_projection rejected = { 0 };

    /* Untyped payload identity must never stand in for an archive view. */
    artifact_complete_observation saved_archive_semantic =
        archive_semantic[0];
    archive_semantic[0].family = ARTIFACT_OBSERVATION_PAYLOAD;
    if (!status && artifact_complete_project(
            &population, &workspace.value, &rejected)
            != ARTIFACT_ERROR_COMPLETE)
        status = ARTIFACT_ERROR_COMPLETE;
    archive_semantic[0] = saved_archive_semantic;

    /* A publisher cannot obtain green by declaring one fewer typed owner. */
    artifact_complete_population omitted_population = population;
    --omitted_population.required_semantic_occurrences[
        ARTIFACT_OBSERVATION_IMMUTABLE_READ - 1u];
    if (!status && artifact_complete_project(
            &omitted_population, &workspace.value, &rejected)
            != ARTIFACT_ERROR_COMPLETE)
        status = ARTIFACT_ERROR_COMPLETE;

    /* The program proof is derived from the one normal-instruction
     * population. A component count cannot conceal a changed instruction. */
    static const pl_u8 normal_different[] = NORMAL_CELL('D');
    static const artifact_cell changed_instruction[] = {
        { normal_move, (pl_u32)sizeof(normal_move) },
        { normal_different, (pl_u32)sizeof(normal_different) },
    };
    artifact_program_population changed_program = program;
    changed_program.instruction = changed_instruction;
    artifact_complete_population changed_program_population = population;
    changed_program_population.program = &changed_program;
    if (!status && artifact_complete_project(
            &changed_program_population, &workspace.value, &rejected)
            != ARTIFACT_ERROR_COMPLETE)
        status = ARTIFACT_ERROR_COMPLETE;

    /* Exact byte owners and generated-cell coordinates have independent
     * closure cardinalities.  Shortening either input is also an omission,
     * even when the shortened prefix still reconstructs itself. */
    artifact_complete_population omitted_payload = population;
    omitted_payload.payload_occurrences = PAYLOAD_COUNT - 1u;
    if (!status && artifact_complete_project(
            &omitted_payload, &workspace.value, &rejected)
            != ARTIFACT_ERROR_COMPLETE)
        status = ARTIFACT_ERROR_COMPLETE;
    artifact_complete_population omitted_cell = population;
    omitted_cell.cell_coordinates = CELL_COUNT - 1u;
    if (!status && artifact_complete_project(
            &omitted_cell, &workspace.value, &rejected)
            != ARTIFACT_ERROR_COMPLETE)
        status = ARTIFACT_ERROR_COMPLETE;

    artifact_complete_population omitted_archive = population;
    omitted_archive.archive_count = 0u;
    if (!status && artifact_complete_project(
            &omitted_archive, &workspace.value, &rejected)
            != ARTIFACT_ERROR_COMPLETE)
        status = ARTIFACT_ERROR_COMPLETE;

    artifact_complete_population omitted_namespace = population;
    omitted_namespace.namespace_projection = 0;
    if (!status && artifact_complete_project(
            &omitted_namespace, &workspace.value, &rejected)
            != ARTIFACT_ERROR_COMPLETE)
        status = ARTIFACT_ERROR_COMPLETE;

    /* Archive byte generation is part of this gate, not an adjacent green.
     * The payload ranks and semantic count remain valid, but a changed byte
     * in the claimed canonical stream must still reject publication. */
    archive_bytes[archive_byte_count - 1u] ^= 1u;
    if (!status && artifact_complete_project(
            &population, &workspace.value, &rejected)
            != ARTIFACT_ERROR_ARCHIVE)
        status = ARTIFACT_ERROR_COMPLETE;
    archive_bytes[archive_byte_count - 1u] ^= 1u;

    /* Completeness is vacuous for a declared empty family.  Requiring a fake
     * archive member or fake residual would add storage with no distinguisher.
     * The family bits instead certify that their zero closure cardinalities
     * and total generators were checked. */
    static const pl_u8 empty_archive_bytes[] = {
        '!', '<', 'a', 'r', 'c', 'h', '>', '\n',
    };
    artifact_archive_instance empty_archive = {
        .view = { 0 },
        .canonical_bytes = empty_archive_bytes,
        .canonical_byte_count = sizeof(empty_archive_bytes),
    };
    artifact_complete_population vacuous = population;
    vacuous.required_semantic_occurrences[4] = 0u;
    vacuous.required_semantic_occurrences[5] = 0u;
    vacuous.archives = &empty_archive;
    vacuous.required_archive_members = 0u;
    vacuous.required_archive_symbols = 0u;
    vacuous.archive_semantic = 0;
    vacuous.archive_semantic_occurrences = 0u;
    vacuous.archive_member_payload_base = 0u;
    vacuous.actual_cells = generated;
    if (!status)
        status = artifact_complete_project(
            &vacuous, &workspace.value, &rejected);
    if (!status && (rejected.semantic_family_mask != 0x3fu
            || rejected.semantic_family_occurrences[4]
            || rejected.semantic_family_occurrences[5]
            || rejected.archive.archives != 1u
            || rejected.archive.members
            || rejected.archive.symbols
            || rejected.derived.exception_cells))
        status = ARTIFACT_ERROR_COMPLETE;

    archive_semantic_response[
        archive_semantic[0].response_bytes - 1u] ^= 1u;
    if (!status && artifact_complete_project(
            &population, &workspace.value, &rejected)
            != ARTIFACT_ERROR_COMPLETE)
        status = ARTIFACT_ERROR_COMPLETE;
    archive_semantic_response[
        archive_semantic[0].response_bytes - 1u] ^= 1u;

    archive_symbol_response[20] ^= 1u;
    if (!status && artifact_complete_project(
            &population, &workspace.value, &rejected)
            != ARTIFACT_ERROR_COMPLETE)
        status = ARTIFACT_ERROR_COMPLETE;
    archive_symbol_response[20] ^= 1u;

    artifact_cell changed_actual[CELL_COUNT];
    memcpy(changed_actual, actual, sizeof(changed_actual));
    changed_actual[3] = (artifact_cell)CELL("exception-B");
    artifact_complete_population changed_cell_population = population;
    changed_cell_population.actual_cells = changed_actual;
    if (!status && artifact_complete_project(
            &changed_cell_population, &workspace.value, &rejected)
            != ARTIFACT_ERROR_PAYLOAD)
        status = ARTIFACT_ERROR_COMPLETE;

    if (status) {
        fprintf(stderr, "complete sharing composition: RED (%d; "
                "families=%x:%u/%u/%u/%u/%u/%u semantic=%u/%llu/%llu "
                "program=%u/%u/%u/%llu/%llu payload=%u/%llu/%llu/%llu "
                "archive=%u/%u/%u/%llu derived=%u/%u/%u "
                "factor=%u/%llu/%llu)\n",
                status, projection.semantic_family_mask,
                projection.semantic_family_occurrences[0],
                projection.semantic_family_occurrences[1],
                projection.semantic_family_occurrences[2],
                projection.semantic_family_occurrences[3],
                projection.semantic_family_occurrences[4],
                projection.semantic_family_occurrences[5],
                projection.semantic.classes,
                (unsigned long long)
                    projection.semantic.generated_rank_cells,
                (unsigned long long)
                    projection.semantic.retained_rank_cells,
                projection.program.instruction_occurrences,
                projection.program.instruction_classes,
                projection.program.future.future.classes,
                (unsigned long long)
                    projection.program.opened_instruction_bytes,
                (unsigned long long)
                    projection.program.retained_instruction_bytes,
                projection.payload.classes,
                (unsigned long long)
                    projection.payload_rank.residual.retained_child_cells,
                (unsigned long long)
                    projection.payload_rank.residual.opened_child_cells,
                (unsigned long long)
                    projection.payload.duplicate_bytes_eliminated,
                projection.archive.archives,
                projection.archive.members,
                projection.archive.symbols,
                (unsigned long long)projection.archive.removed_archive_bytes,
                projection.derived.generated_cells,
                projection.derived.exception_cells,
                projection.derived.exception_classes,
                projection.factor.reference_tokens,
                (unsigned long long)projection.factor.referenced_bytes,
                (unsigned long long)projection.factor.unresolved_bit_gap);
    } else {
        printf("complete sharing composition: green "
               "(%u typed occurrences/%u classes, %u payloads/%u owners, "
               "%u generated cells, %u generated archive bytes, "
               "%llu factor-covered bytes)\n",
               (unsigned)SEMANTIC_COUNT, projection.semantic.classes,
               (unsigned)PAYLOAD_COUNT, projection.payload.classes,
               projection.derived.generated_cells,
               archive_byte_count,
               (unsigned long long)projection.factor.referenced_bytes);
    }
    release(&workspace);
    return status ? 1 : 0;
}
