#include <artifact/complete.h>

static const pl_u8 archive_member_domain[] = "gnu-ar-member-view-v1";
static const pl_u8 archive_symbol_domain[] = "gnu-ar-symbol-view-v1";

static int equal_bytes(const pl_u8 *left, const pl_u8 *right, pl_u32 bytes)
{
    for (pl_u32 index = 0u; index < bytes; ++index)
        if (left[index] != right[index]) return 0;
    return 1;
}

static int equal_cell(const artifact_cell *left, const artifact_cell *right)
{
    return left->length == right->length
        && equal_bytes(left->bytes, right->bytes, left->length);
}

static int archive_observation_matches(
    const artifact_complete_observation *observation,
    const artifact_archive_member *member,
    pl_u8 *scratch, pl_u32 capacity)
{
    if (!observation || !member || !scratch || !observation->response
            || observation->domain_bytes
               != sizeof(archive_member_domain) - 1u
            || !equal_bytes(observation->domain, archive_member_domain,
                            (pl_u32)(sizeof(archive_member_domain) - 1u)))
        return 0;
    pl_u32 written = 0u;
    return !artifact_archive_member_response_write(
                member, scratch, capacity, &written)
        && observation->response_bytes == written
        && equal_bytes(observation->response, scratch, written);
}

static int archive_symbol_observation_matches(
    const artifact_complete_observation *observation,
    const artifact_archive_symbol *symbol,
    pl_u8 *scratch, pl_u32 capacity)
{
    if (!observation || !symbol || !scratch || !observation->response
            || observation->domain_bytes
               != sizeof(archive_symbol_domain) - 1u
            || !equal_bytes(observation->domain, archive_symbol_domain,
                            (pl_u32)(sizeof(archive_symbol_domain) - 1u)))
        return 0;
    pl_u32 written = 0u;
    return !artifact_archive_symbol_response_write(
                symbol, scratch, capacity, &written)
        && observation->response_bytes == written
        && equal_bytes(observation->response, scratch, written);
}

int artifact_complete_prepare(
    const artifact_complete_population *population,
    const artifact_complete_workspace *workspace,
    artifact_byte_view *canonical,
    artifact_complete_projection *out)
{
    const pl_u32 all_semantic_families =
        (1u << ARTIFACT_SEMANTIC_FAMILIES) - 1u;
    if (!population || !workspace || !canonical || !out
            || !population->payloads
            || !population->payload_occurrences || !population->actual_cells
            || !population->generated_cells || !population->cell_coordinates
            || !population->program
            || !workspace->payload_end)
        return ARTIFACT_ERROR_COMPLETE_RANGE;
    if (!population->required_semantic_family_mask
            || (population->required_semantic_family_mask
                & ~all_semantic_families))
        return ARTIFACT_ERROR_COMPLETE_RANGE;
    if (population->payload_occurrences
            != population->required_payload_occurrences
            || !population->payload_projection
            || population->payload_projection->occurrences
               != population->payload_occurrences
            || population->cell_coordinates
               != population->required_cell_coordinates
            || population->archive_count
               != population->required_archive_count
            || (population->archive_count && !population->archives))
        return ARTIFACT_ERROR_COMPLETE;
    if (population->required_namespace_paths
            || population->required_namespace_inodes) {
        if (!population->namespace_projection
                || population->namespace_projection->paths
                   != population->required_namespace_paths
                || population->namespace_projection->inodes
                   != population->required_namespace_inodes)
            return ARTIFACT_ERROR_COMPLETE;
    } else if (population->namespace_projection) {
        return ARTIFACT_ERROR_COMPLETE;
    }

    artifact_complete_projection result = { 0 };
    pl_u32 archive_members = 0u, archive_symbols = 0u;
    for (pl_u32 archive = 0u; archive < population->archive_count;
            ++archive) {
        pl_u32 members = population->archives[archive].view.member_count;
        pl_u32 symbols = population->archives[archive].view.symbol_count;
        if (archive_members > 0xffffffffu - members
                || archive_symbols > 0xffffffffu - symbols)
            return ARTIFACT_ERROR_COMPLETE_RANGE;
        archive_members += members;
        archive_symbols += symbols;
    }
    if (archive_members != population->required_archive_members
            || archive_symbols != population->required_archive_symbols
            || archive_members > 0xffffffffu - archive_symbols
            || population->archive_semantic_occurrences
               != archive_members + archive_symbols
            || (population->archive_semantic_occurrences
                && !population->archive_semantic))
        return ARTIFACT_ERROR_COMPLETE;
    for (pl_u32 occurrence = 0u;
            occurrence < population->archive_semantic_occurrences;
            ++occurrence)
        if (population->archive_semantic[occurrence].family
                != ARTIFACT_OBSERVATION_ARCHIVE_MEMBER)
            return ARTIFACT_ERROR_COMPLETE;
    if (archive_members
            && (population->archive_member_payload_base
                > population->payload_occurrences
                || archive_members > population->payload_occurrences
                   - population->archive_member_payload_base))
        return ARTIFACT_ERROR_COMPLETE;
    pl_u32 flattened_member = 0u;
    for (pl_u32 archive = 0u; archive < population->archive_count;
            ++archive)
        for (pl_u32 member = 0u;
                member < population->archives[archive].view.member_count;
                ++member, ++flattened_member)
            if (!population->archives[archive].member_payload_occurrence
                    || population->archives[archive]
                       .member_payload_occurrence[member]
                       != population->archive_member_payload_base
                          + flattened_member)
                return ARTIFACT_ERROR_COMPLETE;
    if (!population->program->arms
            || population->program->states
               > 0xffffffffu / population->program->arms)
        return ARTIFACT_ERROR_COMPLETE;
    result.semantic_family_occurrences[
        ARTIFACT_OBSERVATION_BLOCK - 1u] = population->program->states;
    result.semantic_family_occurrences[
        ARTIFACT_OBSERVATION_SLICE - 1u] = 0u;
    result.semantic_family_occurrences[
        ARTIFACT_OBSERVATION_INSTRUCTION - 1u] = 0u;
    result.semantic_family_occurrences[
        ARTIFACT_OBSERVATION_IMMUTABLE_READ - 1u] =
        population->payload_occurrences;
    result.semantic_family_occurrences[
        ARTIFACT_OBSERVATION_ARCHIVE_MEMBER - 1u] =
        archive_members + archive_symbols;
    result.semantic_family_mask = population->required_semantic_family_mask;
    for (pl_u32 family = 0u; family + 1u < ARTIFACT_SEMANTIC_FAMILIES;
            ++family) {
        pl_u32 present = result.semantic_family_occurrences[family];
        int enabled = !!(population->required_semantic_family_mask
                         & (1u << family));
        if ((!enabled && present)
                || present
                   != population->required_semantic_occurrences[family])
            return ARTIFACT_ERROR_COMPLETE;
    }

    int status = artifact_program_project(
        population->program, &workspace->program, &result.program);
    if (!status && (result.program.instruction_classes
                    != population->required_program_instruction_classes
            || result.program.future.future.classes
               != population->required_program_future_classes))
        status = ARTIFACT_ERROR_COMPLETE;
    result.block_future = result.program.future;
    if (!status)
        status = artifact_rank_map_project(
            workspace->program.future.future.state_class,
            population->program->states,
            result.block_future.future.classes,
            &workspace->block_future_rank,
            &result.block_future_rank);
    for (pl_u32 state = 0u;
            !status && state < population->program->states; ++state) {
        pl_u32 reopened = 0u;
        status = artifact_rank_map_lookup(
            &workspace->block_future_rank, &result.block_future_rank,
            state, &reopened);
        if (!status && reopened
                != workspace->program.future.future.state_class[state])
            status = ARTIFACT_ERROR_COMPLETE;
    }

    artifact_share_projection archive_semantic = { 0 };
    if (!status && population->archive_semantic_occurrences)
        status = artifact_share_project(
            population->archive_semantic,
            population->archive_semantic_occurrences,
            &workspace->archive_semantic, &archive_semantic);
    if (!status)
        result.payload = *population->payload_projection;
    if (!status && population->namespace_projection) {
        status = artifact_namespace_validate(
            population->namespace_projection,
            &workspace->namespace_workspace);
        if (!status)
            result.namespace_projection =
                *population->namespace_projection;
    }
    for (pl_u32 material = 0u;
            !status
            && material < result.namespace_projection.material_occurrences;
            ++material) {
        const artifact_payload *required =
            &workspace->namespace_workspace.material[material];
        pl_u32 rank = 0u;
        status = artifact_payload_find(
            population->payloads, population->payload_occurrences,
            &workspace->payload,
            required->bytes, required->length, &rank);
    }
    flattened_member = 0u;
    for (pl_u32 archive = 0u;
            !status && archive < population->archive_count; ++archive) {
        const artifact_archive_view *view =
            &population->archives[archive].view;
        for (pl_u32 member = 0u;
                !status && member < view->member_count;
                ++member, ++flattened_member) {
            const artifact_archive_member *value = &view->members[member];
            pl_u32 bytes = 0u;
            pl_u8 *material = workspace->archive.generated;
            status = artifact_archive_member_material_write(
                value, material, workspace->archive.generated_capacity,
                &bytes);
            if (!status) {
                pl_u32 rank = 0u;
                status = artifact_payload_find(
                    population->payloads, population->payload_occurrences,
                    &workspace->payload, material, bytes, &rank);
            }
        }
        for (pl_u32 symbol = 0u;
                !status && symbol < view->symbol_count; ++symbol) {
            const artifact_archive_symbol *value = &view->symbols[symbol];
            pl_u32 bytes = 0u;
            pl_u8 *material = workspace->archive.generated;
            status = artifact_archive_symbol_material_write(
                value, material, workspace->archive.generated_capacity,
                &bytes);
            if (!status) {
                pl_u32 rank = 0u;
                status = artifact_payload_find(
                    population->payloads, population->payload_occurrences,
                    &workspace->payload, material, bytes, &rank);
            }
        }
    }
    if (!status)
        status = artifact_rank_map_project(
            workspace->payload.share.rank, population->payload_occurrences,
            result.payload.classes, &workspace->payload_rank,
            &result.payload_rank);
    for (pl_u32 occurrence = 0u;
            !status && occurrence < population->payload_occurrences;
            ++occurrence) {
        pl_u32 reopened = 0u;
        status = artifact_rank_map_lookup(
            &workspace->payload_rank, &result.payload_rank,
            occurrence, &reopened);
        if (!status && reopened
                != workspace->payload.share.rank[occurrence])
            status = ARTIFACT_ERROR_COMPLETE;
    }
    if (!status && population->archive_count)
        status = artifact_archive_complete_project(
            population->archives, population->archive_count,
            population->payloads, population->payload_occurrences,
            &result.payload,
            &workspace->archive, &result.archive);
    if (!status && (result.archive.archives
                    != population->required_archive_count
            || result.archive.members
               != population->required_archive_members
            || result.archive.symbols
               != population->required_archive_symbols
            || result.archive.opened_archive_bytes
               != result.archive.generated_archive_bytes))
        status = ARTIFACT_ERROR_COMPLETE;
    pl_u32 archive_semantic_at = 0u;
    for (pl_u32 archive = 0u;
            !status && archive < population->archive_count; ++archive)
        for (pl_u32 member = 0u;
                !status
                && member < population->archives[archive].view.member_count;
                ++member, ++archive_semantic_at)
            if (!archive_observation_matches(
                    &population->archive_semantic[archive_semantic_at],
                    &population->archives[archive].view.members[member],
                    workspace->archive.generated,
                    workspace->archive.generated_capacity))
                status = ARTIFACT_ERROR_COMPLETE;
    for (pl_u32 archive = 0u;
            !status && archive < population->archive_count; ++archive)
        for (pl_u32 symbol = 0u;
                !status
                && symbol < population->archives[archive].view.symbol_count;
                ++symbol, ++archive_semantic_at)
            if (!archive_symbol_observation_matches(
                    &population->archive_semantic[archive_semantic_at],
                    &population->archives[archive].view.symbols[symbol],
                    workspace->archive.generated,
                    workspace->archive.generated_capacity))
                status = ARTIFACT_ERROR_COMPLETE;
    if (!status
            && archive_semantic_at
               != population->archive_semantic_occurrences)
        status = ARTIFACT_ERROR_COMPLETE;
    if (!status && (result.payload.unique_bytes > 0xffffffffull
            || result.payload.classes > workspace->payload_end_capacity))
        status = ARTIFACT_ERROR_COMPLETE_RANGE;

    artifact_byte_view view = { 0 };
    if (!status)
        status = artifact_payload_view(
            population->payloads, population->payload_occurrences,
            &workspace->payload, &result.payload,
            workspace->payload_end, workspace->payload_end_capacity,
            &view);
    if (!status && view.bytes != result.payload.unique_bytes)
        status = ARTIFACT_ERROR_COMPLETE;

    if (!status)
        status = artifact_derive_project(
            population->actual_cells, population->generated_cells,
            population->cell_coordinates, &workspace->derived,
            &result.derived);
    for (pl_u32 coordinate = 0u;
            !status && coordinate < population->cell_coordinates;
            ++coordinate) {
        artifact_cell reopened = { 0 };
        status = artifact_derive_cell(
            population->actual_cells, population->generated_cells,
            population->cell_coordinates, &workspace->derived,
            coordinate, &reopened);
        if (!status && !equal_cell(
                &reopened, &population->actual_cells[coordinate]))
            status = ARTIFACT_ERROR_COMPLETE;
    }
    result.semantic_family_occurrences[
        ARTIFACT_OBSERVATION_DERIVED_CELL - 1u] =
        result.derived.exception_cells;
    if (!status) {
        pl_u32 family = ARTIFACT_OBSERVATION_DERIVED_CELL - 1u;
        int enabled = !!(population->required_semantic_family_mask
                         & (1u << family));
        if ((!enabled && result.derived.exception_cells)
                || result.derived.exception_cells
                   != population->required_semantic_occurrences[family])
            status = ARTIFACT_ERROR_COMPLETE;
    }
    for (pl_u32 exception = 0u;
            !status && exception < result.derived.exception_cells;
            ++exception) {
        const artifact_complete_observation *value =
            &workspace->derived.observation[exception];
        pl_u32 rank = 0u;
        status = artifact_payload_find(
            population->payloads, population->payload_occurrences,
            &workspace->payload, value->response,
            value->response_bytes, &rank);
    }

    pl_u64 semantic_occurrences = 0u;
    pl_u64 semantic_classes = 0u;
    for (pl_u32 family = 0u; family < ARTIFACT_SEMANTIC_FAMILIES;
            ++family)
        semantic_occurrences += result.semantic_family_occurrences[family];
    semantic_classes = (pl_u64)result.block_future.future.classes
        + result.payload.classes
        + archive_semantic.classes
        + result.derived.exception_classes;
    if (!status && (semantic_occurrences > 0xffffffffu
            || semantic_classes > semantic_occurrences))
        status = ARTIFACT_ERROR_COMPLETE_RANGE;
    if (!status)
        result.semantic = (artifact_semantic_projection){
            (pl_u32)semantic_occurrences, (pl_u32)semantic_classes,
            (pl_u32)semantic_occurrences, 0u,
        };

    if (status) return status;

    result.canonical_byte_extent = (pl_u32)view.bytes;
    *canonical = view;
    *out = result;
    return 0;
}

int artifact_complete_factor(
    const artifact_byte_view *canonical,
    const artifact_factor_index_workspace *workspace,
    pl_u8 *factor_code, pl_u32 factor_code_capacity,
    artifact_complete_projection *in_out)
{
    if (!canonical || !workspace || !factor_code || !in_out
            || artifact_byte_view_validate(canonical)
            || canonical->bytes != in_out->canonical_byte_extent)
        return ARTIFACT_ERROR_COMPLETE_RANGE;
    artifact_factor_projection factor = { 0 };
    artifact_factor_code_projection code = { 0 };
    int status = artifact_factor_index_project(
        canonical, workspace, &factor);
    if (!status)
        status = artifact_factor_code_write(
            canonical, workspace->source, workspace->length,
            workspace->vector_capacity,
            factor_code, factor_code_capacity, &code);
    if (!status)
        status = artifact_factor_code_verify(
            factor_code, code.payload_bytes, code.payload_bits,
            canonical, &code);
    if (!status && (factor.unresolved_bit_gap
            || code.payload_bits != factor.retained_bits))
        status = ARTIFACT_ERROR_COMPLETE;
    if (status) return status;
    in_out->factor = factor;
    in_out->factor_code = code;
    return 0;
}

int artifact_complete_project(
    const artifact_complete_population *population,
    const artifact_complete_workspace *workspace,
    artifact_complete_projection *out)
{
    if (!workspace || !workspace->factor_code || !out)
        return ARTIFACT_ERROR_COMPLETE_RANGE;
    artifact_byte_view canonical = { 0 };
    artifact_complete_projection result = { 0 };
    int status = artifact_complete_prepare(
        population, workspace, &canonical, &result);
    if (!status)
        status = artifact_complete_factor(
            &canonical, &workspace->factor,
            workspace->factor_code, workspace->factor_code_capacity,
            &result);
    if (status) return status;
    *out = result;
    return 0;
}
