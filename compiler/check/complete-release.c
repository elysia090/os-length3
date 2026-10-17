#define _POSIX_C_SOURCE 200809L

#include <artifact/complete.h>
#include <artifact/executable.h>
#include <artifact/factor-codec.h>
#include <artifact/factor-index.h>
#include <artifact/namespace-posix.h>
#include <artifact/payload.h>
#include <artifact/program.h>
#include <postlink/compiler.h>

#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

typedef struct release_cell_chunk {
    struct release_cell_chunk *next;
    size_t used;
    size_t capacity;
    pl_u8 bytes[];
} release_cell_chunk;

typedef struct {
    const pl_u8 *bytes;
    pl_u32 length;
    pl_u64 hash;
} release_cell_slot;

typedef struct {
    release_cell_chunk *chunk;
    release_cell_slot *slot;
    pl_u32 slot_capacity;
    pl_u32 slots;
    pl_u64 opened_bytes;
    pl_u64 unique_bytes;
    pl_u64 occurrences;
} release_cell_pool;

typedef struct {
    artifact_cell *instruction;
    artifact_cell *emitted;
    pl_u32 *successor;
    pl_u64 *emitted_file_offset;
    artifact_cell *optimized_elf;
    pl_u32 state_capacity;
    pl_u32 elf_capacity;
    pl_u32 state_capacity_growths;
    pl_u32 elf_capacity_growths;
    pl_u32 states;
    pl_u64 source_instructions;
    pl_u32 elfs;
    release_cell_pool cells;
} release_population;

typedef struct {
    release_population *release;
    pl_u32 state_base;
    pl_u32 expected_states;
    pl_u64 expected_instructions;
    pl_u32 blocks_seen;
    pl_u32 emitted_seen;
    pl_u32 previous_blocks;
    pl_u32 committed;
} release_observer;

typedef struct {
    pl_u8 *bytes;
    pl_u32 byte_count;
    artifact_archive_member *member;
    artifact_archive_symbol *symbol;
    pl_u32 *member_header;
    pl_u32 *member_payload_occurrence;
    artifact_archive_instance instance;
} release_archive;

typedef struct {
    pl_u8 *digest;
    pl_u32 *vector;
    artifact_share_workspace value;
} owned_share;

typedef struct {
    pl_u8 *digest;
    pl_u32 *vector;
    pl_u32 capacity;
} owned_share_scratch;

typedef struct {
    pl_u32 *observation;
    pl_u8 *scratch;
    pl_u32 *children;
    pl_u32 *levels;
    artifact_rank_map_workspace value;
} owned_rank_map;

static void put_u64_be(pl_u8 *target, pl_u64 value);

static int geometric_capacity(pl_u32 current, pl_u32 required,
                              pl_u32 limit, pl_u32 *out)
{
    if (!out || required > limit) return 0;
    if (required <= current) {
        *out = current;
        return 1;
    }
    pl_u32 capacity = current ? current : 1u;
    while (capacity < required) {
        if (capacity > limit / 2u) {
            capacity = limit;
            break;
        }
        capacity *= 2u;
    }
    if (capacity < required) return 0;
    *out = capacity;
    return 1;
}

static int logarithmic_growth(pl_u32 capacity, pl_u32 growths)
{
    pl_u32 bound = capacity ? 1u : 0u;
    while (capacity > 1u) {
        capacity >>= 1u;
        ++bound;
    }
    return growths <= bound;
}

static const pl_u8 archive_member_domain[] = "gnu-ar-member-view-v1";
static const pl_u8 archive_symbol_domain[] = "gnu-ar-symbol-view-v1";

static void free_cell(artifact_cell *cell)
{
    free((void *)(uintptr_t)cell->bytes);
    *cell = (artifact_cell){ 0 };
}

static pl_u64 cell_hash(const pl_u8 *bytes, pl_u32 length)
{
    pl_u64 hash = UINT64_C(1469598103934665603);
    for (pl_u32 index = 0u; index < length; ++index) {
        hash ^= bytes[index];
        hash *= UINT64_C(1099511628211);
    }
    return hash ? hash : 1u;
}

static int grow_cell_slots(release_cell_pool *pool)
{
    pl_u32 capacity = pool->slot_capacity
        ? pool->slot_capacity * 2u : 1024u;
    if (capacity < pool->slot_capacity
            || capacity > 0x80000000u)
        return 0;
    release_cell_slot *slot = calloc(capacity, sizeof(*slot));
    if (!slot) return 0;
    for (pl_u32 old = 0u; old < pool->slot_capacity; ++old) {
        release_cell_slot value = pool->slot[old];
        if (!value.hash) continue;
        pl_u32 at = (pl_u32)value.hash & (capacity - 1u);
        while (slot[at].hash) at = (at + 1u) & (capacity - 1u);
        slot[at] = value;
    }
    free(pool->slot);
    pool->slot = slot;
    pool->slot_capacity = capacity;
    return 1;
}

static pl_u8 *allocate_cell_bytes(release_cell_pool *pool, pl_u32 length)
{
    release_cell_chunk *chunk = pool->chunk;
    if (!chunk || length > chunk->capacity - chunk->used) {
        size_t capacity = 65536u;
        if (capacity < length) capacity = length;
        if (capacity > SIZE_MAX - sizeof(*chunk)) return 0;
        chunk = malloc(sizeof(*chunk) + capacity);
        if (!chunk) return 0;
        *chunk = (release_cell_chunk){ pool->chunk, 0u, capacity };
        pool->chunk = chunk;
    }
    pl_u8 *result = chunk->bytes + chunk->used;
    chunk->used += length;
    return result;
}

static int intern_cell(release_population *release, artifact_cell *target,
                       const pl_u8 *bytes, pl_u32 length)
{
    if (!release || !target || !bytes || !length) return 0;
    release_cell_pool *pool = &release->cells;
    if (pool->opened_bytes > 0xffffffffffffffffull - length
            || pool->occurrences == 0xffffffffffffffffull)
        return 0;
    pool->opened_bytes += length;
    ++pool->occurrences;
    if (!pool->slot_capacity
            || pool->slots >= pool->slot_capacity / 2u)
        if (!grow_cell_slots(pool)) return 0;
    pl_u64 hash = cell_hash(bytes, length);
    pl_u32 at = (pl_u32)hash & (pool->slot_capacity - 1u);
    while (pool->slot[at].hash) {
        release_cell_slot *candidate = &pool->slot[at];
        if (candidate->hash == hash && candidate->length == length
                && !memcmp(candidate->bytes, bytes, length)) {
            *target = (artifact_cell){ candidate->bytes, length };
            return 1;
        }
        at = (at + 1u) & (pool->slot_capacity - 1u);
    }
    if (pool->unique_bytes > 0xffffffffffffffffull - length)
        return 0;
    pl_u8 *copy = allocate_cell_bytes(pool, length);
    if (!copy) return 0;
    memcpy(copy, bytes, length);
    pool->unique_bytes += length;
    pool->slot[at] = (release_cell_slot){ copy, length, hash };
    ++pool->slots;
    *target = (artifact_cell){ copy, length };
    return 1;
}

static void close_cell_pool(release_cell_pool *pool)
{
    release_cell_chunk *chunk = pool->chunk;
    while (chunk) {
        release_cell_chunk *next = chunk->next;
        free(chunk);
        chunk = next;
    }
    free(pool->slot);
    *pool = (release_cell_pool){ 0 };
}

static int grow_states(release_population *release, pl_u32 capacity)
{
    if (capacity <= release->state_capacity) return 1;
    if (!geometric_capacity(
            release->state_capacity, capacity, 0xfffffffeu, &capacity))
        return 0;
    artifact_cell *instruction = realloc(
        release->instruction, (size_t)capacity * sizeof(*instruction));
    if (!instruction) return 0;
    release->instruction = instruction;
    artifact_cell *emitted = realloc(
        release->emitted, (size_t)capacity * sizeof(*emitted));
    if (!emitted) return 0;
    release->emitted = emitted;
    pl_u32 *successor = realloc(
        release->successor, (size_t)capacity * 2u * sizeof(*successor));
    if (!successor) return 0;
    release->successor = successor;
    pl_u64 *emitted_file_offset = realloc(
        release->emitted_file_offset,
        (size_t)capacity * sizeof(*emitted_file_offset));
    if (!emitted_file_offset) return 0;
    release->emitted_file_offset = emitted_file_offset;
    for (pl_u32 state = release->state_capacity; state < capacity; ++state) {
        release->instruction[state] = (artifact_cell){ 0 };
        release->emitted[state] = (artifact_cell){ 0 };
        release->emitted_file_offset[state] = 0u;
    }
    release->state_capacity = capacity;
    ++release->state_capacity_growths;
    return 1;
}

static int grow_elfs(release_population *release, pl_u32 capacity)
{
    if (capacity <= release->elf_capacity) return 1;
    if (!geometric_capacity(
            release->elf_capacity, capacity, 0xffffffffu, &capacity))
        return 0;
    artifact_cell *elf = realloc(
        release->optimized_elf, (size_t)capacity * sizeof(*elf));
    if (!elf) return 0;
    release->optimized_elf = elf;
    for (pl_u32 index = release->elf_capacity; index < capacity; ++index)
        release->optimized_elf[index] = (artifact_cell){ 0 };
    release->elf_capacity = capacity;
    ++release->elf_capacity_growths;
    return 1;
}

static int seal_states(release_population *release)
{
    /* Geometric construction capacity amortizes append; it is not a live
     * semantic population. End that slack and the intern index's lifetime
     * before allocating whole-release proof columns. Payload chunks stay. */
    if (!release->states) return 0;
    void *value = realloc(release->instruction,
        (size_t)release->states * sizeof(*release->instruction));
    if (!value) return 0;
    release->instruction = value;
    value = realloc(release->emitted,
        (size_t)release->states * sizeof(*release->emitted));
    if (!value) return 0;
    release->emitted = value;
    value = realloc(release->successor,
        (size_t)release->states * 2u * sizeof(*release->successor));
    if (!value) return 0;
    release->successor = value;
    value = realloc(release->emitted_file_offset,
        (size_t)release->states * sizeof(*release->emitted_file_offset));
    if (!value) return 0;
    release->emitted_file_offset = value;
    release->state_capacity = release->states;
    free(release->cells.slot);
    release->cells.slot = 0;
    release->cells.slot_capacity = 0u;
    return 1;
}

static void clear_pending(release_observer *observer)
{
    release_population *release = observer->release;
    for (pl_u32 index = 0u; index < observer->previous_blocks; ++index) {
        pl_u32 state = observer->state_base + index;
        release->instruction[state] = (artifact_cell){ 0 };
        /* Emitted bodies are borrowed slices of the final optimized ELF.
         * They never own a second byte population. */
        release->emitted[state] = (artifact_cell){ 0 };
    }
    observer->previous_blocks = 0u;
}

static int observe_begin(void *opaque, pl_u32 states, pl_u32 arms,
                         pl_u64 source_instructions)
{
    release_observer *observer = opaque;
    if (!observer || !states || arms != 2u || !source_instructions
            || observer->state_base > 0xffffffffu - states)
        return -1;
    clear_pending(observer);
    if (!grow_states(observer->release, observer->state_base + states))
        return -1;
    observer->expected_states = states;
    observer->expected_instructions = source_instructions;
    observer->blocks_seen = 0u;
    observer->emitted_seen = 0u;
    observer->committed = 0u;
    if (getenv("ARTIFACT_STAGE_PROFILE"))
        fprintf(stderr,
                "artifact ELF observations begin: states=%u, source-instructions=%llu\n",
                states, (unsigned long long)source_instructions);
    return 0;
}

static int observe_block(
    void *opaque, pl_u32 state,
    const pl_u8 *instruction, pl_u32 instruction_bytes,
    const pl_u32 successor[2])
{
    release_observer *observer = opaque;
    release_population *release = observer ? observer->release : 0;
    if (!release || state != observer->blocks_seen
            || state >= observer->expected_states
            || !instruction || !instruction_bytes
            || successor[0] >= observer->expected_states
            || successor[1] >= observer->expected_states)
        return -1;
    pl_u32 global = observer->state_base + state;
    if (!intern_cell(
            release, &release->instruction[global],
            instruction, instruction_bytes))
        return -1;
    release->successor[(pl_u64)global * 2u] =
        observer->state_base + successor[0];
    release->successor[(pl_u64)global * 2u + 1u] =
        observer->state_base + successor[1];
    ++observer->blocks_seen;
    observer->previous_blocks = observer->blocks_seen;
    if (!(state & 0xffffu) && getenv("ARTIFACT_STAGE_PROFILE"))
    {
        struct rusage usage = { 0 };
        (void)getrusage(RUSAGE_SELF, &usage);
        fprintf(stderr,
                "artifact ELF observations: %u/%u peak-rss-kib=%ld\n",
                observer->blocks_seen, observer->expected_states,
                usage.ru_maxrss);
    }
    return 0;
}

static int observe_commit(void *opaque,
                          const pl_u8 *optimized_elf,
                          pl_u64 optimized_elf_bytes)
{
    release_observer *observer = opaque;
    release_population *release = observer ? observer->release : 0;
    if (!release || observer->blocks_seen != observer->expected_states
            || observer->emitted_seen != observer->expected_states
            || !optimized_elf || !optimized_elf_bytes
            || optimized_elf_bytes > 0xffffffffu)
        return -1;
    if (release->source_instructions
            > 0xffffffffffffffffull - observer->expected_instructions)
        return -1;
    if (!grow_elfs(release, release->elfs + 1u))
        return -1;
    /* The compiler's final output allocation becomes the sole release byte
     * owner. append_elf() transfers that allocation after this callback;
     * copying it here would retain one complete linear term per ELF. */
    release->optimized_elf[release->elfs] = (artifact_cell){
        optimized_elf, (pl_u32)optimized_elf_bytes,
    };
    release->states += observer->expected_states;
    release->source_instructions += observer->expected_instructions;
    ++release->elfs;
    observer->previous_blocks = 0u;
    observer->committed = 1u;
    if (getenv("ARTIFACT_STAGE_PROFILE"))
        fprintf(stderr,
                "artifact ELF observations committed: %u states, %llu bytes\n",
                observer->expected_states,
                (unsigned long long)optimized_elf_bytes);
    return 0;
}

static int observe_emitted(
    void *opaque, pl_u32 state, pl_u64 file_offset,
    const pl_u8 *bytes, pl_u32 byte_count)
{
    release_observer *observer = opaque;
    release_population *release = observer ? observer->release : 0;
    if (!release || state != observer->emitted_seen
            || state >= observer->expected_states || !bytes)
        return -1;
    pl_u32 global = observer->state_base + state;
    release->emitted_file_offset[global] = file_offset;
    release->emitted[global] = (artifact_cell){ bytes, byte_count };
    ++observer->emitted_seen;
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

static int open_release_archive(const char *path, release_archive *out)
{
    pl_u64 byte_count = 0u;
    if (!path || !out || !read_file(path, &out->bytes, &byte_count)
            || byte_count > 0xffffffffu)
        return ARTIFACT_ERROR_ARCHIVE_RANGE;
    out->byte_count = (pl_u32)byte_count;
    pl_u32 members = 0u, symbols = 0u;
    int status = artifact_archive_read_measure(
        out->bytes, out->byte_count, &members, &symbols);
    out->member = !status && members
        ? calloc(members, sizeof(*out->member)) : 0;
    out->symbol = !status && symbols
        ? calloc(symbols, sizeof(*out->symbol)) : 0;
    out->member_header = !status && members
        ? malloc((size_t)members * sizeof(*out->member_header)) : 0;
    out->member_payload_occurrence = !status && members
        ? malloc((size_t)members
                 * sizeof(*out->member_payload_occurrence)) : 0;
    if (!status && ((members && (!out->member || !out->member_header
                    || !out->member_payload_occurrence))
            || (symbols && !out->symbol)))
        status = ARTIFACT_ERROR_ARCHIVE_RANGE;
    artifact_archive_read_workspace reader = {
        out->member, out->symbol, out->member_header, members, symbols,
    };
    artifact_archive_view view = { 0 };
    if (!status)
        status = artifact_archive_read(
            out->bytes, out->byte_count, &reader, &view);
    if (!status)
        out->instance = (artifact_archive_instance){
            view, out->member_payload_occurrence,
            out->bytes, out->byte_count,
        };
    return status;
}

static void close_release_archive(release_archive *archive)
{
    if (!archive) return;
    free(archive->member_payload_occurrence);
    free(archive->member_header);
    free(archive->symbol);
    free(archive->member);
    free(archive->bytes);
    *archive = (release_archive){ 0 };
}

static int write_file_atomic(
    const char *source_path, const char *target_path,
    const pl_u8 *bytes, pl_u64 length)
{
    struct stat source;
    size_t path_bytes;
    char *temporary;
    FILE *file;
    int descriptor;
    int status = 0;
    if (!source_path || !target_path || !bytes || !length
            || stat(source_path, &source))
        return 0;
    path_bytes = strlen(target_path);
    if (path_bytes > (size_t)-1 - 48u) return 0;
    temporary = malloc(path_bytes + 48u);
    if (!temporary) return 0;
    if (snprintf(temporary, path_bytes + 48u, "%s.partial.%lu",
                 target_path, (unsigned long)getpid()) < 0) {
        free(temporary);
        return 0;
    }
    file = fopen(temporary, "wb");
    if (!file) {
        free(temporary);
        return 0;
    }
    descriptor = fileno(file);
    if (length > (pl_u64)(size_t)-1
            || fwrite(bytes, 1u, (size_t)length, file) != (size_t)length
            || fflush(file) || descriptor < 0 || fsync(descriptor)
            || fchmod(descriptor, source.st_mode & 07777u))
        status = -1;
    if (fclose(file)) status = -1;
    if (!status && rename(temporary, target_path)) status = -1;
    if (status) (void)unlink(temporary);
    free(temporary);
    return status == 0;
}

typedef struct {
    clock_t read;
    clock_t measure;
    clock_t compile;
    clock_t publish;
    pl_u64 input_bytes;
    pl_u64 output_bytes;
    pl_u64 maximum_workspace_bytes;
    pl_u64 normalization_escape_source_bytes;
    pl_u64 normalization_escape_output_bytes;
    pl_u64 normalization_escape_work;
    pl_u64 normalization_escape_blocks;
    pl_u64 pareto_unresolved_blocks;
    pl_u32 files;
    pl_u32 retries;
} append_profile;

static append_profile elf_profile;

static int append_elf(release_population *release, const char *path,
                      const char *output_path)
{
    int profile = getenv("ARTIFACT_STAGE_PROFILE") != 0;
    if (profile) fprintf(stderr, "artifact ELF begin: %s\n", path);
    pl_u8 *input = 0, *output = 0, *workspace = 0;
    pl_u64 input_bytes = 0u, output_bytes = 0u;
    postlink_measurement measurement;
    postlink_report report;
    release_observer context = {
        .release = release,
        .state_base = release->states,
    };
    postlink_observer observer = {
        &context, observe_begin, observe_block,
        observe_emitted, observe_commit,
    };
    clock_t begin = clock();
    int read = read_file(path, &input, &input_bytes);
    elf_profile.read += clock() - begin;
    begin = clock();
    int status = read
        ? postlink_measure(input, input_bytes, &measurement, &report)
        : POSTLINK_ERROR_INPUT_ELF;
    clock_t measure_ticks = clock() - begin;
    elf_profile.measure += measure_ticks;
    if (profile)
        fprintf(stderr,
                "artifact ELF measured: %llu bytes, status=%d, "
                "output-capacity=%llu workspace=%llu, %.6f CPU seconds\n",
                (unsigned long long)input_bytes, status,
                (unsigned long long)(status ? 0u : measurement.output_capacity),
                (unsigned long long)(status ? 0u : measurement.workspace_bytes),
                (double)measure_ticks / (double)CLOCKS_PER_SEC);
    if (!status && (measurement.output_capacity > (pl_u64)(size_t)-1
            || measurement.workspace_bytes > (pl_u64)(size_t)-1))
        status = POSTLINK_ERROR_WORKSPACE;
    output = status ? 0 : malloc((size_t)measurement.output_capacity);
    workspace = status ? 0 : malloc((size_t)measurement.workspace_bytes);
    if (!status && (!output || !workspace)) status = POSTLINK_ERROR_WORKSPACE;
    for (;;) {
        if (status) break;
        begin = clock();
        status = postlink_compile_observed(
            input, input_bytes, output, measurement.output_capacity,
            &output_bytes, workspace, measurement.workspace_bytes,
            &observer, &report);
        clock_t compile_ticks = clock() - begin;
        elf_profile.compile += compile_ticks;
        if (profile)
            fprintf(stderr,
                    "artifact ELF compiled: status=%d, states=%u, "
                    "output=%llu bytes, required-workspace=%llu, "
                    "%.6f CPU seconds\n",
                    status, report.native_blocks,
                    (unsigned long long)output_bytes,
                    (unsigned long long)report.required_workspace_bytes,
                    (double)compile_ticks / (double)CLOCKS_PER_SEC);
        if (status != POSTLINK_ERROR_WORKSPACE
                || report.required_workspace_bytes
                   <= measurement.workspace_bytes)
            break;
        if (report.required_workspace_bytes > (pl_u64)(size_t)-1) break;
        /* Observation callbacks populate caller-owned release cells before a
         * later compiler phase can discover its exact exceptional workspace.
         * A retry is a fresh transaction: retain capacities, but discard every
         * uncommitted value before the compiler replays the same linked ELF. */
        if (!context.committed) clear_pending(&context);
        pl_u8 *larger = realloc(
            workspace, (size_t)report.required_workspace_bytes);
        if (!larger) break;
        workspace = larger;
        measurement.workspace_bytes = report.required_workspace_bytes;
        ++elf_profile.retries;
        status = 0;
    }
    if (!status && (!context.committed
            || context.blocks_seen != context.expected_states
            || context.emitted_seen != context.expected_states))
        status = POSTLINK_ERROR_INCOMPLETE;
    if (!status && output_path) {
        begin = clock();
        int written = write_file_atomic(
            path, output_path, output, output_bytes);
        elf_profile.publish += clock() - begin;
        if (!written) status = POSTLINK_ERROR_EMIT;
    }
    if (status && !context.committed) {
        clear_pending(&context);
    }
    if (status) {
        fprintf(stderr, "post-link release input rejected: %s: %s (%d)\n",
                path, postlink_status_string(status), status);
        if (report.proof_stage || report.native_failure_stage)
            fprintf(stderr,
                    "  proof-stage=%u native-stage=%u status=%d "
                    "value=0x%llx limit=0x%llx bytes=%llu/%llu "
                    "workspace=%llu\n",
                    report.proof_stage, report.native_failure_stage,
                    report.native_failure_status,
                    (unsigned long long)report.native_failure_address,
                    (unsigned long long)report.native_failure_target,
                    (unsigned long long)report.native_failure_output,
                    (unsigned long long)report.native_failure_expected,
                    (unsigned long long)report.required_workspace_bytes);
    }
    free(workspace);
    /* observe_commit published this exact allocation into optimized_elf.
     * Every emitted block is a non-owning slice of it. */
    if (context.committed) output = 0;
    free(output);
    free(input);
    if (!status) {
        ++elf_profile.files;
        elf_profile.input_bytes += input_bytes;
        elf_profile.output_bytes += output_bytes;
        if (measurement.workspace_bytes > elf_profile.maximum_workspace_bytes)
            elf_profile.maximum_workspace_bytes = measurement.workspace_bytes;
        elf_profile.normalization_escape_source_bytes +=
            report.native_normalization_escape_source_bytes;
        elf_profile.normalization_escape_output_bytes +=
            report.native_normalization_escape_output_bytes;
        elf_profile.normalization_escape_work +=
            report.native_normalization_escape_work;
        elf_profile.normalization_escape_blocks +=
            report.native_normalization_escape_blocks;
        elf_profile.pareto_unresolved_blocks +=
            report.native_pareto_unresolved_blocks;
    }
    return status;
}

static int open_share(pl_u32 capacity, owned_share *out)
{
    if (!capacity || capacity > 0xffffffffu / PL_SHA256_BYTES) return 0;
    out->digest = malloc((size_t)capacity * PL_SHA256_BYTES);
    out->vector = malloc((size_t)capacity * 4u * sizeof(*out->vector));
    if (!out->digest || !out->vector) return 0;
    out->value = (artifact_share_workspace){
        out->digest, capacity * PL_SHA256_BYTES,
        out->vector, out->vector + capacity,
        out->vector + capacity * 2u, out->vector + capacity * 3u,
        capacity,
    };
    return 1;
}

static void close_share(owned_share *share)
{
    free(share->vector);
    free(share->digest);
    *share = (owned_share){ 0 };
}

static int open_share_scratch(pl_u32 capacity, owned_share_scratch *out)
{
    if (!capacity || capacity > 0xffffffffu / PL_SHA256_BYTES) return 0;
    out->digest = malloc((size_t)capacity * PL_SHA256_BYTES);
    out->vector = malloc((size_t)capacity * 2u * sizeof(*out->vector));
    if (!out->digest || !out->vector) return 0;
    out->capacity = capacity;
    return 1;
}

static int open_share_result(
    pl_u32 capacity, const owned_share_scratch *scratch, owned_share *out)
{
    if (!capacity || !scratch || capacity > scratch->capacity) return 0;
    out->vector = malloc((size_t)capacity * 2u * sizeof(*out->vector));
    if (!out->vector) return 0;
    out->value = (artifact_share_workspace){
        scratch->digest, scratch->capacity * PL_SHA256_BYTES,
        scratch->vector, scratch->vector + scratch->capacity,
        out->vector, out->vector + capacity, capacity,
    };
    return 1;
}

static void close_share_scratch(owned_share_scratch *scratch)
{
    free(scratch->vector);
    free(scratch->digest);
    *scratch = (owned_share_scratch){ 0 };
}

static int rank_map_working_bytes(pl_u32 occurrences, size_t *out)
{
    pl_u32 padded = 0u, scratch = 0u, nodes = 0u, levels = 0u;
    if (!out || artifact_rank_map_measure(
            occurrences, &padded, &scratch, &nodes, &levels))
        return 0;
    *out = (((size_t)padded * sizeof(pl_u32) + 7u) & ~(size_t)7u)
         + scratch;
    return 1;
}

static int open_rank_map(pl_u32 occurrences, void *working,
                         size_t working_bytes, owned_rank_map *out)
{
    pl_u32 padded = 0u, scratch_bytes = 0u;
    pl_u32 nodes = 0u, levels = 0u;
    if (artifact_rank_map_measure(
            occurrences, &padded, &scratch_bytes, &nodes, &levels))
        return 0;
    size_t observation_bytes =
        ((size_t)padded * sizeof(*out->observation) + 7u) & ~(size_t)7u;
    if (!working || observation_bytes > working_bytes
            || scratch_bytes > working_bytes - observation_bytes)
        return 0;
    /* Program refinement and each rank-map construction are sequential in
     * artifact_complete_prepare. Only the two trees survive their respective
     * construction; lookups read child/level columns, never this working view. */
    out->observation = working;
    out->scratch = (pl_u8 *)working + observation_bytes;
    out->children = malloc((size_t)nodes * 2u * sizeof(*out->children));
    out->levels = malloc((size_t)levels * sizeof(*out->levels));
    if (!out->observation || !out->scratch
            || !out->children || !out->levels)
        return 0;
    out->value = (artifact_rank_map_workspace){
        out->observation, padded,
        { out->scratch, scratch_bytes,
          out->children, out->children + nodes,
          nodes, out->levels, levels },
    };
    return 1;
}

static void close_rank_map(owned_rank_map *map)
{
    free(map->levels);
    free(map->children);
    /* observation/scratch borrow the enclosing transaction's phase arena. */
    *map = (owned_rank_map){ 0 };
}

static void put_u64_be(pl_u8 *target, pl_u64 value)
{
    for (pl_u32 index = 0u; index < 8u; ++index)
        target[index] = (pl_u8)(value >> ((7u - index) * 8u));
}

static void release_population_close(release_population *release)
{
    for (pl_u32 index = 0u; index < release->elfs; ++index)
        free_cell(&release->optimized_elf[index]);
    close_cell_pool(&release->cells);
    free(release->optimized_elf);
    free(release->successor);
    free(release->emitted_file_offset);
    free(release->instruction);
    free(release->emitted);
    *release = (release_population){ 0 };
}

static int parse_u32(const char *text, pl_u32 *out)
{
    if (!text || !*text || !out) return 0;
    pl_u64 value = 0u;
    for (const unsigned char *at = (const unsigned char *)text;
            *at; ++at) {
        if (*at < '0' || *at > '9'
                || value > (0xffffffffull - (*at - '0')) / 10u)
            return 0;
        value = value * 10u + (*at - '0');
    }
    *out = (pl_u32)value;
    return 1;
}

static int namespace_content_ordinal(
    const artifact_namespace_posix *namespace,
    const char *root, const char *path, pl_u32 content_kind,
    pl_u32 *ordinal)
{
    if (!namespace || !root || !path || !ordinal) return 0;
    size_t root_bytes = strlen(root);
    while (root_bytes > 1u && root[root_bytes - 1u] == '/') --root_bytes;
    const char *relative = path;
    if (root_bytes) {
        if (strncmp(root, path, root_bytes)
                || (path[root_bytes] && path[root_bytes] != '/'))
            return 0;
        relative = path + root_bytes;
        if (*relative == '/') ++relative;
    }
    size_t relative_bytes = strlen(relative);
    if (relative_bytes > 0xffffffffu) return 0;
    pl_u32 path_rank = 0u, inode_rank = 0u;
    if (artifact_namespace_reopen_lookup(
            &namespace->projection, &namespace->workspace,
            (const pl_u8 *)relative, (pl_u32)relative_bytes,
            &path_rank, &inode_rank))
        return 0;
    artifact_namespace_reopened_inode inode = { 0 };
    if (artifact_namespace_reopen_metadata(
            &namespace->projection, &namespace->workspace,
            inode_rank, &inode)
            || inode.kind != ARTIFACT_NAMESPACE_REGULAR
            || inode.content_kind != content_kind)
        return 0;
    *ordinal = inode.content_ordinal;
    return 1;
}

static int build_argument_order(
    const artifact_namespace_posix *namespace,
    const char *root, char **argv, int base, int stride,
    pl_u32 count, pl_u32 content_kind,
    const pl_u32 content_counts[4], pl_u32 **out)
{
    if (!content_counts || content_kind > ARTIFACT_NAMESPACE_ARCHIVE
            || content_counts[content_kind] != count)
        return 0;
    pl_u32 *order = count ? malloc((size_t)count * sizeof(*order)) : 0;
    if (count && !order) return 0;
    for (pl_u32 index = 0u; index < count; ++index)
        order[index] = 0xffffffffu;
    for (pl_u32 argument = 0u; argument < count; ++argument) {
        pl_u32 ordinal = 0u;
        if (!namespace_content_ordinal(
                namespace, root, argv[base + (int)argument * stride],
                content_kind, &ordinal)
                || ordinal >= count || order[ordinal] != 0xffffffffu) {
            free(order);
            return 0;
        }
        order[ordinal] = argument;
    }
    *out = order;
    return 1;
}

static void profile_phase(int enabled, const char *name, clock_t *previous)
{
    if (!enabled || !name || !previous) return;
    clock_t now = clock();
    double seconds = now >= *previous
        ? (double)(now - *previous) / (double)CLOCKS_PER_SEC : 0.0;
    struct rusage usage = { 0 };
    (void)getrusage(RUSAGE_SELF, &usage);
    fprintf(stderr,
            "artifact stage phase: %s %.6f CPU seconds peak-rss-kib=%ld\n",
            name, seconds, usage.ru_maxrss);
    *previous = now;
}

int main(int argc, char **argv)
{
    int phase_profile = getenv("ARTIFACT_STAGE_PROFILE") != 0;
    clock_t phase_clock = clock();
    release_population release = { 0 };
    pl_u32 archive_count = 0u, external_payload_count = 0u;
    int namespace_prefix = argc >= 12 && !strcmp(argv[1], "--stage")
        && !strcmp(argv[3], "--namespace-root")
        && !strcmp(argv[5], "--payload-root");
    int archive_flag = namespace_prefix ? 7 : 3;
    int structured_prefix = argc > archive_flag + 4
        && !strcmp(argv[1], "--stage")
        && !strcmp(argv[archive_flag], "--archives")
        && parse_u32(argv[archive_flag + 1], &archive_count)
        && archive_count
           <= (pl_u32)(argc - archive_flag - 3);
    int archive_base = archive_flag + 2;
    int after_archives = archive_base + (int)archive_count;
    int payload_stage = structured_prefix
        && after_archives + 2 < argc
        && !strcmp(argv[after_archives], "--payloads")
        && parse_u32(argv[after_archives + 1], &external_payload_count)
        && external_payload_count
           <= (pl_u32)(argc - after_archives - 3);
    int payload_base = after_archives + (payload_stage ? 2 : 0);
    int elf_marker = payload_base + (int)external_payload_count;
    int archive_stage = structured_prefix && elf_marker < argc
        && !strcmp(argv[elf_marker], "--elfs")
        && !((argc - elf_marker - 1) & 1);
    int legacy_stage = !archive_stage && argc >= 5
        && !strcmp(argv[1], "--stage") && !((argc - 3) & 1);
    int stage = archive_stage || legacy_stage;
    int namespace_stage = namespace_prefix && archive_stage;
    int pair_base = archive_stage ? elf_marker + 1 : 3;
    pl_u32 image_count = argc == 3 ? 2u
        : stage ? (pl_u32)((argc - pair_base) / 2) : 0u;
    pl_u32 profile_image_limit = image_count;
    const char *profile_limit_text = getenv("ARTIFACT_STAGE_PROFILE_LIMIT");
    if (phase_profile && profile_limit_text) {
        char *end = 0;
        unsigned long value = strtoul(profile_limit_text, &end, 10);
        if (end != profile_limit_text && !*end && value
                && value < profile_image_limit)
            profile_image_limit = (pl_u32)value;
    }
    const char *report_path = stage ? argv[2] : 0;
    int status = image_count ? 0 : ARTIFACT_ERROR_PROGRAM_RANGE;
    pl_u32 release_stage = 0u;
    artifact_namespace_posix namespace = { 0 };
    clock_t namespace_begin = clock();
    if (!status && namespace_stage)
        status = artifact_namespace_posix_open(argv[4], &namespace);
    clock_t namespace_open_ticks = clock() - namespace_begin;
    pl_u32 namespace_content_counts[4] = { 0u, 0u, 0u, 0u };
    if (!status && namespace_stage)
        status = artifact_namespace_reopen_content_counts(
            &namespace.projection, &namespace.workspace,
            namespace_content_counts);
    pl_u32 *image_order = 0, *archive_order = 0, *external_order = 0;
    clock_t order_begin = clock();
    if (!status && namespace_stage
            && (!build_argument_order(
                    &namespace, argv[4], argv, pair_base, 2,
                    image_count, ARTIFACT_NAMESPACE_ELF,
                    namespace_content_counts, &image_order)
                || !build_argument_order(
                    &namespace, argv[6], argv, archive_base, 1,
                    archive_count, ARTIFACT_NAMESPACE_ARCHIVE,
                    namespace_content_counts, &archive_order)
                || !build_argument_order(
                    &namespace, argv[6], argv, payload_base, 1,
                    external_payload_count, ARTIFACT_NAMESPACE_PAYLOAD,
                    namespace_content_counts, &external_order)))
        status = ARTIFACT_ERROR_NAMESPACE;
    clock_t argument_order_ticks = clock() - order_begin;
    if (phase_profile)
        fprintf(stderr,
                "artifact namespace preparation: open=%.6f order=%.6f "
                "CPU seconds\n",
                (double)namespace_open_ticks / (double)CLOCKS_PER_SEC,
                (double)argument_order_ticks / (double)CLOCKS_PER_SEC);
    pl_u32 *source_state_offset = status ? 0 : calloc(
        (size_t)image_count + 1u, sizeof(*source_state_offset));
    if (!status && !source_state_offset)
        status = ARTIFACT_ERROR_PROGRAM_RANGE;
    pl_u32 first_states = 0u;
    pl_u64 first_instructions = 0u;
    for (pl_u32 image = 0u;
            !status && image < profile_image_limit; ++image) {
        source_state_offset[image] = release.states;
        pl_u32 argument = namespace_stage ? image_order[image] : image;
        const char *source = stage
            ? argv[pair_base + (int)argument * 2] : argv[1 + image];
        const char *target = stage
            ? argv[pair_base + (int)argument * 2 + 1] : 0;
        status = append_elf(&release, source, target);
        if (phase_profile) {
            struct rusage usage = { 0 };
            (void)getrusage(RUSAGE_SELF, &usage);
            fprintf(stderr,
                    "artifact ELF file: %u/%u status=%d states=%u "
                    "unique-cell-bytes=%llu peak-rss-kib=%ld\n",
                    image + 1u, profile_image_limit, status,
                    release.states,
                    (unsigned long long)release.cells.unique_bytes,
                    usage.ru_maxrss);
        }
        if (!image) {
            first_states = release.states;
            first_instructions = release.source_instructions;
        }
    }
    if (phase_profile)
        fprintf(stderr,
                "artifact ELF population: files=%u input=%llu output=%llu "
                "workspace-max=%llu retries=%u read/measure/compile/publish="
                "%.6f/%.6f/%.6f/%.6f CPU seconds; "
                "semantic-cells=%llu opened=%llu unique=%llu\n",
                elf_profile.files,
                (unsigned long long)elf_profile.input_bytes,
                (unsigned long long)elf_profile.output_bytes,
                (unsigned long long)elf_profile.maximum_workspace_bytes,
                elf_profile.retries,
                (double)elf_profile.read / (double)CLOCKS_PER_SEC,
                (double)elf_profile.measure / (double)CLOCKS_PER_SEC,
                (double)elf_profile.compile / (double)CLOCKS_PER_SEC,
                (double)elf_profile.publish / (double)CLOCKS_PER_SEC,
                (unsigned long long)release.cells.occurrences,
                (unsigned long long)release.cells.opened_bytes,
                (unsigned long long)release.cells.unique_bytes);
    profile_phase(phase_profile, "postlink-elf-population", &phase_clock);
    if (!status && profile_image_limit != image_count)
        status = ARTIFACT_ERROR_PROGRAM_RANGE;
    if (!status) source_state_offset[image_count] = release.states;
    if (!status && (!logarithmic_growth(
                release.state_capacity, release.state_capacity_growths)
            || !logarithmic_growth(
                release.elf_capacity, release.elf_capacity_growths)))
        status = ARTIFACT_ERROR_PROGRAM_RANGE;
    if (!status && !stage && (release.states != first_states * 2u
            || release.source_instructions != first_instructions * 2u))
        status = ARTIFACT_ERROR_PROGRAM;
    if (!status && !seal_states(&release))
        status = ARTIFACT_ERROR_PROGRAM_RANGE;

    release_archive *archive = archive_count
        ? calloc(archive_count, sizeof(*archive)) : 0;
    artifact_archive_instance *archive_instance = archive_count
        ? calloc(archive_count, sizeof(*archive_instance)) : 0;
    if (!status && archive_count && (!archive || !archive_instance))
        status = ARTIFACT_ERROR_ARCHIVE_RANGE;
    pl_u32 archive_members = 0u, archive_symbols = 0u;
    pl_u32 maximum_archive_members = 0u;
    pl_u32 maximum_archive_bytes = 0u;
    for (pl_u32 index = 0u;
            !status && index < archive_count; ++index) {
        pl_u32 argument = namespace_stage ? archive_order[index] : index;
        status = open_release_archive(
            argv[archive_base + (int)argument], &archive[index]);
        pl_u32 members = archive[index].instance.view.member_count;
        pl_u32 symbols = archive[index].instance.view.symbol_count;
        if (!status && (archive_members > 0xffffffffu - members
                || archive_symbols > 0xffffffffu - symbols))
            status = ARTIFACT_ERROR_ARCHIVE_RANGE;
        if (!status) {
            archive_members += members;
            archive_symbols += symbols;
            if (members > maximum_archive_members)
                maximum_archive_members = members;
            if (archive[index].byte_count > maximum_archive_bytes)
                maximum_archive_bytes = archive[index].byte_count;
            archive_instance[index] = archive[index].instance;
        }
    }

    pl_u8 **external_payload_bytes = external_payload_count
        ? calloc(external_payload_count, sizeof(*external_payload_bytes)) : 0;
    artifact_payload *external_payload = external_payload_count
        ? calloc(external_payload_count, sizeof(*external_payload)) : 0;
    pl_u64 external_payload_opened_bytes = 0u;
    if (!status && external_payload_count
            && (!external_payload_bytes || !external_payload))
        status = ARTIFACT_ERROR_PAYLOAD_RANGE;
    for (pl_u32 index = 0u;
            !status && index < external_payload_count; ++index) {
        pl_u32 argument = namespace_stage ? external_order[index] : index;
        pl_u64 bytes = 0u;
        if (!read_file(argv[payload_base + (int)argument],
                       &external_payload_bytes[index], &bytes)
                || bytes > 0xffffffffu
                || external_payload_opened_bytes
                   > 0xffffffffffffffffull - bytes)
            status = ARTIFACT_ERROR_PAYLOAD_RANGE;
        else {
            external_payload[index] = (artifact_payload){
                external_payload_bytes[index], (pl_u32)bytes,
            };
            external_payload_opened_bytes += bytes;
        }
    }
    profile_phase(phase_profile, "archive-and-payload-open", &phase_clock);

    pl_u32 *future_rank = 0;
    pl_u32 future_bytes = 0u;
    pl_u8 *future_scratch = 0;
    owned_share_scratch program_share_scratch = { 0 };
    owned_share instruction_share = { 0 };
    artifact_program_workspace workspace = { 0 };
    artifact_program_population population = {
        .instruction = release.instruction,
        .successor = release.successor,
        .states = release.states,
        .arms = 2u,
    };
    artifact_program_projection projection = { 0 };
    artifact_payload *elf_fragment = 0;
    artifact_complete_observation *elf_observation = 0;
    pl_u32 *image_fragment_offset = 0;
    pl_u8 *elf_factor_code = 0;
    pl_u64 *elf_extent = 0, *factor_cost_tree = 0;
    pl_u32 *factor_vector = 0;
    pl_u64 canonical_byte_extent = 0u;
    pl_u32 factor_vector_capacity = 0u;
    pl_u32 factor_tree_capacity = 0u;
    artifact_executable_projection elf_projection = { 0 };
    artifact_payload_projection complete_payload_projection = { 0 };
    artifact_complete_projection complete_projection = { 0 };
    owned_share elf_share = { 0 };
    owned_share complete_payload_share = { 0 };
    owned_share archive_semantic_share = { 0 };
    owned_rank_map block_future_rank = { 0 };
    owned_rank_map payload_rank = { 0 };
    artifact_complete_observation *complete_payload_observation = 0;
    artifact_payload *complete_payload = 0;
    artifact_payload *archive_material = 0;
    artifact_complete_observation *archive_observation = 0;
    pl_u8 *archive_material_bytes = 0;
    pl_u8 *archive_response_bytes = 0;
    pl_u64 *archive_member_header = 0;
    pl_u32 *archive_long_name_offset = 0;
    pl_u8 *archive_generated = 0;
    artifact_cell *actual_coordinate = 0;
    pl_u8 *actual_coordinate_bytes = 0;
    if (!status && release.elfs != image_count)
        status = ARTIFACT_ERROR_EXECUTABLE;
    artifact_executable_population executable_population = {
        release.optimized_elf, source_state_offset,
        release.emitted, release.emitted_file_offset,
        release.elfs, release.states,
    };
    pl_u32 fragment_capacity = 0u;
    if (!status)
        status = artifact_executable_measure(
            &executable_population, &fragment_capacity);
    elf_fragment = status ? 0 : calloc(
        fragment_capacity, sizeof(*elf_fragment));
    elf_observation = status ? 0 : calloc(
        fragment_capacity, sizeof(*elf_observation));
    image_fragment_offset = status ? 0 : malloc(
        ((size_t)release.elfs + 1u) * sizeof(*image_fragment_offset));
    if (!status && (!elf_fragment || !elf_observation
            || !image_fragment_offset
            || !open_share(fragment_capacity, &elf_share)))
        status = ARTIFACT_ERROR_EXECUTABLE_RANGE;
    artifact_executable_workspace executable_workspace = {
        elf_fragment, fragment_capacity,
        image_fragment_offset, release.elfs + 1u,
        { elf_observation, fragment_capacity, elf_share.value },
    };
    if (!status) {
        release_stage = 20u;
        status = artifact_executable_project(
            &executable_population, &executable_workspace, &elf_projection);
    }
    profile_phase(
        phase_profile, "executable-fragment-projection", &phase_clock);
    if (!status && (elf_projection.fragment.unique_bytes > 0xffffffffull
            || elf_projection.generated_file_coordinates != release.states
            || elf_projection.reconstructed_bytes
               != elf_projection.opened_image_bytes
            || elf_projection.fragment.unique_bytes
               >= elf_projection.opened_image_bytes))
        status = ARTIFACT_ERROR_EXECUTABLE;
    /* Fragment payload cells remain authoritative input below. The quotient
     * digest/order, coordinate map and reconstruction buffer do not: keeping
     * them until factor selection would add an unrelated linear lifetime. */
    close_share(&elf_share);
    free(image_fragment_offset);
    image_fragment_offset = 0;
    free(elf_observation);
    elf_observation = 0;

    pl_u64 archive_response_word_bytes = 0u;
    pl_u64 archive_material_word_bytes = 0u;
    for (pl_u32 index = 0u; !status && index < archive_count; ++index) {
        const artifact_archive_view *view = &archive[index].instance.view;
        for (pl_u32 member = 0u; member < view->member_count; ++member) {
            const artifact_archive_member *value = &view->members[member];
            pl_u64 response = (pl_u64)value->name_bytes + 12u
                            + value->payload_bytes;
            pl_u64 material = (pl_u64)value->name_bytes + 13u;
            if (archive_response_word_bytes > 0xffffffffull - response
                    || archive_material_word_bytes
                       > 0xffffffffull - material)
                status = ARTIFACT_ERROR_ARCHIVE_RANGE;
            else {
                archive_response_word_bytes += response;
                archive_material_word_bytes += material;
            }
        }
        for (pl_u32 symbol = 0u;
                !status && symbol < view->symbol_count; ++symbol) {
            pl_u64 response = (pl_u64)view->symbols[symbol].name_bytes + 8u;
            pl_u64 material = (pl_u64)view->symbols[symbol].name_bytes + 13u;
            if (archive_response_word_bytes > 0xffffffffull - response
                    || archive_material_word_bytes
                       > 0xffffffffull - material)
                status = ARTIFACT_ERROR_ARCHIVE_RANGE;
            else {
                archive_response_word_bytes += response;
                archive_material_word_bytes += material;
            }
        }
    }
    if (!status && archive_members > 0xffffffffu - archive_symbols)
        status = ARTIFACT_ERROR_ARCHIVE_RANGE;
    pl_u32 archive_material_count = status ? 0u
        : archive_members + archive_symbols;
    archive_material = !status && archive_material_count
        ? calloc(archive_material_count, sizeof(*archive_material)) : 0;
    archive_observation = !status && archive_material_count
        ? calloc(archive_material_count, sizeof(*archive_observation)) : 0;
    archive_material_bytes = !status && archive_material_word_bytes
        ? malloc((size_t)archive_material_word_bytes) : 0;
    archive_response_bytes = !status && archive_response_word_bytes
        ? malloc((size_t)archive_response_word_bytes) : 0;
    archive_member_header = !status && maximum_archive_members
        ? malloc((size_t)maximum_archive_members
                 * sizeof(*archive_member_header)) : 0;
    archive_long_name_offset = !status && maximum_archive_members
        ? malloc((size_t)maximum_archive_members
                 * sizeof(*archive_long_name_offset)) : 0;
    archive_generated = !status && maximum_archive_bytes
        ? malloc(maximum_archive_bytes) : 0;
    if (!status && archive_material_count
            && !open_share(
                archive_material_count, &archive_semantic_share))
        status = ARTIFACT_ERROR_ARCHIVE_RANGE;
    if (!status && ((archive_material_count
                    && (!archive_material || !archive_observation
                        || !archive_material_bytes
                        || !archive_response_bytes))
            || (maximum_archive_members
                && (!archive_member_header || !archive_long_name_offset))
            || (archive_count && !archive_generated)))
        status = ARTIFACT_ERROR_ARCHIVE_RANGE;

    if (!status && archive_members > 0xffffffffu
               - elf_projection.fragment_occurrences)
        status = ARTIFACT_ERROR_PAYLOAD_RANGE;
    /* X86N cells are construction witnesses over the selected ordinary x86
     * bytes. artifact_program_project reopens every cell and proves its
     * complete future above; retaining one representative per class here
     * would store the program twice. The independently runnable optimized ELF
     * fragments are the sole executable payload owner. */
    pl_u32 archive_member_payload_base =
        elf_projection.fragment_occurrences;
    pl_u32 flattened_member = 0u, archive_observation_at = 0u;
    pl_u32 material_at = 0u, response_at = 0u;
    for (pl_u32 index = 0u; !status && index < archive_count; ++index) {
        artifact_archive_view *view = &archive[index].instance.view;
        for (pl_u32 member = 0u;
                !status && member < view->member_count;
                ++member, ++flattened_member) {
            artifact_archive_member *value = &archive[index].member[member];
            archive[index].member_payload_occurrence[member] =
                archive_member_payload_base + flattened_member;
            pl_u8 *response = archive_response_bytes + response_at;
            pl_u32 response_bytes = 0u;
            status = artifact_archive_member_response_write(
                value, response,
                (pl_u32)archive_response_word_bytes - response_at,
                &response_bytes);
            if (!status)
                archive_observation[archive_observation_at] =
                    (artifact_complete_observation){
                        ARTIFACT_OBSERVATION_ARCHIVE_MEMBER,
                        archive_member_domain,
                        (pl_u32)(sizeof(archive_member_domain) - 1u),
                        response, response_bytes,
                    };
            pl_u32 written = 0u;
            if (!status)
                status = artifact_archive_member_material_write(
                    value, archive_material_bytes + material_at,
                    (pl_u32)archive_material_word_bytes - material_at,
                    &written);
            if (!status) {
                archive_material[archive_observation_at] =
                    (artifact_payload){
                        archive_material_bytes + material_at, written,
                    };
                material_at += written;
                response_at += response_bytes;
                ++archive_observation_at;
            }
        }
    }
    for (pl_u32 index = 0u; !status && index < archive_count; ++index) {
        artifact_archive_view *view = &archive[index].instance.view;
        for (pl_u32 symbol = 0u;
                !status && symbol < view->symbol_count; ++symbol) {
            artifact_archive_symbol *value = &archive[index].symbol[symbol];
            pl_u8 *response = archive_response_bytes + response_at;
            pl_u32 response_bytes = 0u;
            status = artifact_archive_symbol_response_write(
                value, response,
                (pl_u32)archive_response_word_bytes - response_at,
                &response_bytes);
            if (!status)
                archive_observation[archive_observation_at] =
                    (artifact_complete_observation){
                        ARTIFACT_OBSERVATION_ARCHIVE_MEMBER,
                        archive_symbol_domain,
                        (pl_u32)(sizeof(archive_symbol_domain) - 1u),
                        response, response_bytes,
                    };
            pl_u32 written = 0u;
            if (!status)
                status = artifact_archive_symbol_material_write(
                    value, archive_material_bytes + material_at,
                    (pl_u32)archive_material_word_bytes - material_at,
                    &written);
            if (!status) {
                archive_material[archive_observation_at] =
                    (artifact_payload){
                        archive_material_bytes + material_at, written,
                    };
                material_at += written;
                response_at += response_bytes;
                ++archive_observation_at;
            }
        }
    }
    if (!status && (flattened_member != archive_members
            || archive_observation_at != archive_material_count
            || material_at != archive_material_word_bytes
            || response_at != archive_response_word_bytes))
        status = ARTIFACT_ERROR_ARCHIVE;

    pl_u32 namespace_material_count = namespace_stage
        ? namespace.projection.material_occurrences : 0u;
    pl_u64 complete_payload_count64 =
        (pl_u64)elf_projection.fragment_occurrences
        + archive_members + archive_material_count
        + external_payload_count + namespace_material_count;
    if (!status && complete_payload_count64 > 0xffffffffu)
        status = ARTIFACT_ERROR_PAYLOAD_RANGE;
    pl_u32 complete_payload_count = status ? 0u
        : (pl_u32)complete_payload_count64;
    /* The executable descriptors become the prefix of the sole global owner
     * view. Transfer that allocation; copying N descriptors into a second
     * live array is neither a new observation nor a necessary payload. */
    if (!status) {
        complete_payload = realloc(elf_fragment,
            (size_t)complete_payload_count * sizeof(*complete_payload));
        if (complete_payload) elf_fragment = 0;
    }
    complete_payload_observation = status ? 0 : calloc(
        complete_payload_count, sizeof(*complete_payload_observation));
    if (!status && (!complete_payload || !complete_payload_observation
            || !open_share(
                complete_payload_count, &complete_payload_share)))
        status = ARTIFACT_ERROR_PAYLOAD_RANGE;
    pl_u32 payload_member = 0u;
    for (pl_u32 index = 0u; !status && index < archive_count; ++index)
        for (pl_u32 member = 0u;
                member < archive[index].instance.view.member_count;
                ++member, ++payload_member)
            complete_payload[archive_member_payload_base + payload_member] =
                (artifact_payload){
                    archive[index].member[member].payload,
                    archive[index].member[member].payload_bytes,
                };
    if (!status && payload_member != archive_members)
        status = ARTIFACT_ERROR_ARCHIVE;
    pl_u32 archive_material_base = archive_member_payload_base
                                 + archive_members;
    for (pl_u32 material = 0u;
            !status && material < archive_material_count; ++material)
        complete_payload[archive_material_base + material] =
            archive_material[material];
    pl_u32 external_payload_base = archive_material_base
                                 + archive_material_count;
    for (pl_u32 payload = 0u;
            !status && payload < external_payload_count; ++payload)
        complete_payload[external_payload_base + payload] =
            external_payload[payload];
    pl_u32 namespace_material_base = external_payload_base
                                   + external_payload_count;
    for (pl_u32 material = 0u;
            !status && material < namespace_material_count; ++material)
        complete_payload[namespace_material_base + material] =
            namespace.workspace.material[material];
    artifact_payload_workspace complete_payload_workspace = {
        complete_payload_observation, complete_payload_count,
        complete_payload_share.value,
    };
    if (!status) {
        release_stage = 30u;
        status = artifact_payload_project(
            complete_payload, complete_payload_count,
            &complete_payload_workspace, &complete_payload_projection);
    }
    if (!status && complete_payload_projection.unique_bytes > 0xffffffffull)
        status = ARTIFACT_ERROR_PAYLOAD_RANGE;
    canonical_byte_extent = complete_payload_projection.unique_bytes;
    elf_extent = status ? 0 : malloc(
        (size_t)complete_payload_projection.classes * sizeof(*elf_extent));
    if (!status && !elf_extent)
        status = ARTIFACT_ERROR_PAYLOAD_RANGE;
    /* The complete publication gate below is the sole canonical-word writer.
     * Writing the same N bytes here first only to overwrite them during that
     * gate was a second linear route with no independent observation. */
    profile_phase(phase_profile, "payload-quotient", &phase_clock);

    /* Program and ELF-fragment proof scratch are sequential lifetimes.
     * Keeping the former alive while building a second full-state payload
     * quotient exhausted 8 GiB on the fixed recipe. The exact program proof
     * and its complete-gate recheck still run before any publication. */
    future_rank = status ? 0 : malloc((size_t)release.states * sizeof(*future_rank));
    if (!status)
        status = pl_finite_future_workspace_measure(release.states, 2u, &future_bytes);
    size_t phase_scratch_bytes = future_bytes;
    size_t block_rank_bytes = 0u, payload_rank_bytes = 0u;
    if (!status && (!rank_map_working_bytes(release.states, &block_rank_bytes)
            || !rank_map_working_bytes(complete_payload_count, &payload_rank_bytes)))
        status = ARTIFACT_ERROR_COMPLETE_RANGE;
    if (block_rank_bytes > phase_scratch_bytes) phase_scratch_bytes = block_rank_bytes;
    if (payload_rank_bytes > phase_scratch_bytes) phase_scratch_bytes = payload_rank_bytes;
    future_scratch = status ? 0 : malloc(phase_scratch_bytes);
    if (!status && (!future_rank || !future_scratch
            || !open_share_scratch(release.states, &program_share_scratch)
            || !open_share_result(release.states, &program_share_scratch,
                                  &instruction_share)))
        status = ARTIFACT_ERROR_PROGRAM_RANGE;
    if (!status) {
        workspace = (artifact_program_workspace){
            .future = {
                .immediate = instruction_share.value,
                .future = { future_rank, release.states,
                            future_scratch, future_bytes },
            },
        };
        release_stage = 10u;
        status = artifact_program_project(&population, &workspace, &projection);
    }
    profile_phase(phase_profile, "canonical-program-future", &phase_clock);
    for (pl_u32 state = 0u; !stage && !status && state < first_states; ++state)
        if (future_rank[state] != future_rank[first_states + state])
            status = ARTIFACT_ERROR_PROGRAM;
    if (!status && projection.instruction_occurrences != release.states)
        status = ARTIFACT_ERROR_PROGRAM;
    if (!stage && !status
            && (projection.future.future.classes > first_states
                || projection.future.shared_state_occurrences < first_states
                || projection.retained_instruction_bytes >= projection.opened_instruction_bytes))
        status = ARTIFACT_ERROR_PROGRAM;

    artifact_factor_index_workspace factor_workspace = { 0 };
    pl_u64 factor_workspace_bytes = 0u;
    pl_u64 factor_code_bytes = 0u;

    /* The projections above are the authoritative typed populations. Their
     * domains are disjoint, so the global semantic rank is a family/domain
     * offset plus an already-proved local rank. Do not flatten the same rows
     * into a second 3*states+instructions population. */
    pl_u64 complete_semantic_count64 = (pl_u64)release.states
                                     + complete_payload_count
                                     + archive_material_count;
    if (!status && complete_semantic_count64 > 0xffffffffu)
        status = ARTIFACT_ERROR_COMPLETE_RANGE;
    pl_u32 complete_semantic_count = status ? 0u
        : (pl_u32)complete_semantic_count64;
    actual_coordinate = status ? 0 : calloc(
        release.states, sizeof(*actual_coordinate));
    actual_coordinate_bytes = status ? 0 : malloc(
        (size_t)release.states * 8u);
    if (!status && (!actual_coordinate || !actual_coordinate_bytes
            || !open_rank_map(release.states, future_scratch,
                              phase_scratch_bytes, &block_future_rank)
            || !open_rank_map(
                complete_payload_count, future_scratch,
                phase_scratch_bytes, &payload_rank)))
        status = ARTIFACT_ERROR_COMPLETE_RANGE;

    /* A linked image contributes one layout seed.  Every later emitted-file
     * coordinate is the prefix sum of that seed and the selected block
     * extents.  Thus the coordinate column is checked at every state but is
     * never an N-element stored directory. */
    for (pl_u32 image = 0u; !status && image < release.elfs; ++image) {
        pl_u32 first = source_state_offset[image];
        pl_u32 end = source_state_offset[image + 1u];
        pl_u64 cursor = release.emitted_file_offset[first];
        for (pl_u32 state = first; state < end; ++state) {
            pl_u8 *actual = actual_coordinate_bytes + (size_t)state * 8u;
            put_u64_be(actual, release.emitted_file_offset[state]);
            actual_coordinate[state] = (artifact_cell){ actual, 8u };
            if (release.emitted_file_offset[state] != cursor)
                status = ARTIFACT_ERROR_COMPLETE;
            else if (cursor > 0xffffffffffffffffull
                               - release.emitted[state].length)
                status = ARTIFACT_ERROR_COMPLETE_RANGE;
            else
                cursor += release.emitted[state].length;
        }
    }

    /* Exact retained x86 is a compile-time semantic representative, not an
     * execution fallback. Nonjoint Pareto cells carry independent lower
     * bounds and actual selected costs separately in X86N5. The namespace
     * stage may report these optimization misses, but it must not confuse
     * them with missing executable coordinates. */

    artifact_complete_population complete_population = {
        .required_semantic_family_mask = namespace_stage ? 0x3fu
            : archive_stage ? 0x1fu : 0x0fu,
        .required_semantic_occurrences = {
            release.states, 0u, 0u,
            complete_payload_count, archive_material_count, 0u,
        },
        .program = &population,
        .required_program_instruction_classes =
            projection.instruction_classes,
        .required_program_future_classes =
            projection.future.future.classes,
        .payloads = complete_payload,
        .payload_occurrences = complete_payload_count,
        .required_payload_occurrences = complete_payload_count,
        .payload_projection = &complete_payload_projection,
        .archives = archive_instance,
        .archive_count = archive_count,
        .required_archive_count = archive_count,
        .required_archive_members = archive_members,
        .required_archive_symbols = archive_symbols,
        .archive_semantic = archive_observation,
        .archive_semantic_occurrences = archive_material_count,
        .archive_member_payload_base = archive_member_payload_base,
        .namespace_projection = namespace_stage
            ? &namespace.projection : 0,
        .required_namespace_paths = namespace_stage
            ? namespace.projection.paths : 0u,
        .required_namespace_inodes = namespace_stage
            ? namespace.projection.inodes : 0u,
        .actual_cells = actual_coordinate,
        /* The prefix recurrence above has already checked every generated
         * coordinate. Both views therefore share the one byte population. */
        .generated_cells = actual_coordinate,
        .cell_coordinates = release.states,
        .required_cell_coordinates = release.states,
    };
    artifact_complete_workspace complete_workspace = {
        .program = workspace,
        .block_future_rank = block_future_rank.value,
        .payload = complete_payload_workspace,
        .payload_rank = payload_rank.value,
        .archive_semantic = archive_semantic_share.value,
        .archive = {
            complete_payload_workspace,
            archive_member_header, archive_long_name_offset,
            maximum_archive_members,
            archive_generated, maximum_archive_bytes,
        },
        .namespace_workspace = namespace.workspace,
        .derived = { 0 },
        .payload_end = elf_extent,
        .payload_end_capacity = complete_payload_projection.classes,
    };
    artifact_byte_view canonical = { 0 };
    if (!status) {
        release_stage = 50u;
        status = artifact_complete_prepare(
            &complete_population, &complete_workspace, &canonical,
            &complete_projection);
    }
    profile_phase(phase_profile, "complete-sharing", &phase_clock);
    if (!status) {
        /* The canonical byte view borrows only payload owners, their ranks,
         * and their CSR ends. Program/future/coordinate scratch has no role
         * in factor selection, so end its lifetime before allocating the
         * four full-byte vectors. This keeps two large linear terms from
         * overlapping at the release-wide peak. */
        close_rank_map(&block_future_rank);
        close_share(&instruction_share);
        close_share_scratch(&program_share_scratch);
        free(actual_coordinate_bytes);
        actual_coordinate_bytes = 0;
        free(actual_coordinate);
        actual_coordinate = 0;
        free(future_scratch);
        future_scratch = 0;
        free(future_rank);
        future_rank = 0;
        free(source_state_offset);
        source_state_offset = 0;
        free(release.successor);
        release.successor = 0;
        free(release.emitted_file_offset);
        release.emitted_file_offset = 0;
        free(release.instruction);
        release.instruction = 0;
        free(release.emitted);
        release.emitted = 0;
        close_cell_pool(&release.cells);

        release_stage = 40u;
        status = artifact_factor_index_measure(
            (pl_u32)canonical_byte_extent,
            &factor_vector_capacity, &factor_tree_capacity);
    }
    factor_vector = status ? 0 : malloc(
        (size_t)factor_vector_capacity * 4u * sizeof(*factor_vector));
    factor_cost_tree = status ? 0 : malloc(
        (size_t)factor_tree_capacity * sizeof(*factor_cost_tree));
    if (!status && (!factor_vector || !factor_cost_tree))
        status = ARTIFACT_ERROR_FACTOR_RANGE;
    factor_workspace = (artifact_factor_index_workspace){
        .source = factor_vector
            ? factor_vector + factor_vector_capacity * 2u : 0,
        .length = factor_vector
            ? factor_vector + factor_vector_capacity * 3u : 0,
        .suffix_array = factor_vector,
        .rank = factor_vector
            ? factor_vector + factor_vector_capacity : 0,
        .vector_capacity = factor_vector_capacity,
        .cost_tree = factor_cost_tree,
        .tree_capacity = factor_tree_capacity,
    };
    factor_workspace_bytes =
        (pl_u64)factor_vector_capacity * 4u * sizeof(*factor_vector)
        + (pl_u64)factor_tree_capacity * sizeof(*factor_cost_tree);
    /* One exact writer uses the all-literal upper bound; after selection its
     * dead suffix-array space owns the stored spelling. */
    factor_code_bytes = status ? 0u
        : (canonical_byte_extent * 9u + 7u) >> 3u;
    if (!status && (factor_code_bytes > 0xffffffffu
            || factor_code_bytes
               > (pl_u64)factor_vector_capacity * sizeof(*factor_vector)))
        status = ARTIFACT_ERROR_FACTOR_CODEC_RANGE;
    if (!status) {
        elf_factor_code = (pl_u8 *)(void *)factor_vector;
        release_stage = 50u;
        status = artifact_complete_factor(
            &canonical, &factor_workspace, elf_factor_code,
            (pl_u32)factor_code_bytes, &complete_projection);
    }
    profile_phase(phase_profile, "factor-selection", &phase_clock);
    if (!status && (complete_projection.semantic_family_mask
                    != (namespace_stage ? 0x3fu
                        : archive_stage ? 0x1fu : 0x0fu)
            || complete_projection.program.future.future.classes
               != projection.future.future.classes
            || complete_projection.payload.unique_bytes
               != complete_payload_projection.unique_bytes
            || complete_projection.archive.archives != archive_count
            || complete_projection.archive.members != archive_members
            || complete_projection.archive.symbols != archive_symbols
            || complete_projection.namespace_projection.paths
               != (namespace_stage ? namespace.projection.paths : 0u)
            || complete_projection.namespace_projection.inodes
               != (namespace_stage ? namespace.projection.inodes : 0u)
            || complete_projection.canonical_byte_extent
               != canonical_byte_extent
            || complete_projection.derived.generated_cells != release.states
            || complete_projection.derived.exception_cells
            || !complete_projection.factor.reference_tokens
            || !complete_projection.factor.referenced_bytes))
        status = ARTIFACT_ERROR_COMPLETE;

    if (!status && report_path) {
        FILE *report_file = fopen(report_path, "wb");
        if (!report_file) {
            status = ARTIFACT_ERROR_EXECUTABLE;
        } else {
            if (fprintf(report_file,
                    "format=artifact-executable-stage-v13\n"
                    "complete_gate=1\n"
                    "semantic_family_mask=%u\n"
                    "block_occurrences=%u\n"
                    "slice_occurrences=%u\n"
                    "instruction_occurrences=%u\n"
                    "immutable_occurrences=%u\n"
                    "optimized_elfs=%u\n"
                    "postlink_normalized_emission_complete=%u\n"
                    "postlink_normalization_escape_blocks=%llu\n"
                    "postlink_normalization_escape_source_bytes=%llu\n"
                    "postlink_normalization_escape_output_bytes=%llu\n"
                    "postlink_normalization_escape_work=%llu\n"
                    "postlink_pareto_unresolved_blocks=%llu\n"
                    "states=%u\n"
                    "source_instructions=%llu\n"
                    "state_capacity_growths=%u\n"
                    "elf_capacity_growths=%u\n"
                    "normal_instruction_occurrences=%u\n"
                    "normal_instruction_classes=%u\n"
                    "normal_instruction_shared_occurrences=%u\n"
                    "normal_instruction_opened_bytes=%llu\n"
                    "normal_instruction_class_bytes=%llu\n"
                    "stored_normal_instruction_bytes=%u\n"
                    "normal_instruction_minimum_proofs=%u\n"
                    "normal_instruction_joint_witnesses=%u\n"
                    "normal_instruction_work_lower_bound_sum=%llu\n"
                    "normal_instruction_span_lower_bound_sum=%llu\n"
                    "normal_instruction_maximum_work_lower_bound=%llu\n"
                    "normal_instruction_maximum_span_lower_bound=%llu\n"
                    "checked_successor_coordinates=%llu\n"
                    "stored_residual_state_rows=%u\n"
                    "stored_residual_edge_rows=%u\n"
                    "future_classes=%u\n"
                    "opened_elf_bytes=%llu\n"
                    "unique_fragment_bytes=%llu\n"
                    "canonical_byte_extent=%llu\n"
                    "archive_count=%u\n"
                    "archive_member_occurrences=%u\n"
                    "archive_symbol_occurrences=%u\n"
                    "generated_archive_bytes=%llu\n"
                    "external_payload_occurrences=%u\n"
                    "external_payload_bytes=%llu\n"
                    "namespace_paths=%u\n"
                    "namespace_inodes=%u\n"
                    "namespace_hardlink_aliases=%u\n"
                    "namespace_material_occurrences=%u\n"
                    "namespace_opened_path_bytes=%llu\n"
                    "namespace_retained_basename_bytes=%llu\n"
                    "namespace_topology_bits=%llu\n"
                    "namespace_descriptor_bytes=%llu\n"
                    "factor_bits=%llu\n"
                    "factor_bytes=%u\n"
                    "factor_workspace_bytes=%llu\n"
                    "factor_gap_bits=%llu\n",
                    complete_projection.semantic_family_mask,
                    complete_projection.semantic_family_occurrences[0],
                    complete_projection.semantic_family_occurrences[1],
                    complete_projection.semantic_family_occurrences[2],
                    complete_projection.semantic_family_occurrences[3],
                    release.elfs,
                    elf_profile.normalization_escape_blocks ? 0u : 1u,
                    (unsigned long long)
                        elf_profile.normalization_escape_blocks,
                    (unsigned long long)
                        elf_profile.normalization_escape_source_bytes,
                    (unsigned long long)
                        elf_profile.normalization_escape_output_bytes,
                    (unsigned long long)
                        elf_profile.normalization_escape_work,
                    (unsigned long long)
                        elf_profile.pareto_unresolved_blocks,
                    release.states,
                    (unsigned long long)release.source_instructions,
                    release.state_capacity_growths,
                    release.elf_capacity_growths,
                    projection.instruction_occurrences,
                    projection.instruction_classes,
                    projection.shared_instruction_occurrences,
                    (unsigned long long)
                        projection.opened_instruction_bytes,
                    (unsigned long long)
                        projection.retained_instruction_bytes,
                    0u,
                    projection.minimum_proof_occurrences,
                    projection.joint_witness_occurrences,
                    (unsigned long long)projection.work_lower_bound_sum,
                    (unsigned long long)projection.span_lower_bound_sum,
                    (unsigned long long)projection.maximum_work_lower_bound,
                    (unsigned long long)projection.maximum_span_lower_bound,
                    (unsigned long long)
                        projection.checked_successor_coordinates,
                    projection.retained_residual_state_rows,
                    projection.retained_residual_edge_rows,
                    projection.future.future.classes,
                    (unsigned long long)elf_projection.opened_image_bytes,
                    (unsigned long long)elf_projection.fragment.unique_bytes,
                    (unsigned long long)complete_payload_projection.unique_bytes,
                    archive_count, archive_members, archive_symbols,
                    (unsigned long long)
                        complete_projection.archive.generated_archive_bytes,
                    external_payload_count,
                    (unsigned long long)external_payload_opened_bytes,
                    complete_projection.namespace_projection.paths,
                    complete_projection.namespace_projection.inodes,
                    complete_projection.namespace_projection.hardlink_aliases,
                    complete_projection.namespace_projection
                        .material_occurrences,
                    (unsigned long long)complete_projection
                        .namespace_projection.opened_path_bytes,
                    (unsigned long long)complete_projection
                        .namespace_projection.retained_name_bytes,
                    (unsigned long long)complete_projection
                        .namespace_projection.topology_bits,
                    (unsigned long long)complete_projection
                        .namespace_projection.descriptor_bytes,
                    (unsigned long long)
                        complete_projection.factor.retained_bits,
                    complete_projection.factor_code.payload_bytes,
                    (unsigned long long)factor_workspace_bytes,
                    (unsigned long long)
                        complete_projection.factor.unresolved_bit_gap)
                    < 0)
                status = ARTIFACT_ERROR_EXECUTABLE;
            if (fclose(report_file)) status = ARTIFACT_ERROR_EXECUTABLE;
        }
    }

    if (status)
        fprintf(stderr, "real release complete sharing: RED "
                "(stage %u, %d)\n", release_stage, status);
    else if (!stage)
        printf("real release complete sharing: green "
               "(%u+%u ELF states -> %u global future classes; "
               "%llu -> %llu transient normal-proof class bytes, "
               "0 stored; "
               "%llu final-ELF bytes -> %llu shared fragment bytes + "
               "%llu canonical bytes -> "
               "%llu factor bits, exact round trip)\n",
               first_states, first_states,
               projection.future.future.classes,
               (unsigned long long)projection.opened_instruction_bytes,
               (unsigned long long)projection.retained_instruction_bytes,
               (unsigned long long)elf_projection.opened_image_bytes,
               (unsigned long long)elf_projection.fragment.unique_bytes,
               (unsigned long long)complete_payload_projection.unique_bytes,
                (unsigned long long)
                    complete_projection.factor.retained_bits);
    else
        printf("artifact executable stage: green "
               "(%u ELFs, %u states, %u complete observations, "
               "%llu -> %llu fragment bytes + "
               "%llu canonical bytes, %llu factor bits)\n",
               release.elfs, release.states,
               complete_semantic_count,
               (unsigned long long)elf_projection.opened_image_bytes,
               (unsigned long long)elf_projection.fragment.unique_bytes,
               (unsigned long long)complete_payload_projection.unique_bytes,
                (unsigned long long)
                    complete_projection.factor.retained_bits);

    close_rank_map(&payload_rank);
    close_rank_map(&block_future_rank);
    close_share(&archive_semantic_share);
    free(actual_coordinate_bytes);
    free(actual_coordinate);
    close_share(&complete_payload_share);
    free(complete_payload_observation);
    free(complete_payload);
    free(archive_generated);
    free(archive_long_name_offset);
    free(archive_member_header);
    free(archive_response_bytes);
    free(archive_material_bytes);
    free(archive_observation);
    free(archive_material);
    free(factor_cost_tree);
    free(factor_vector);
    free(elf_extent);
    close_share(&elf_share);
    free(image_fragment_offset);
    free(elf_observation);
    free(elf_fragment);
    close_share(&instruction_share);
    close_share_scratch(&program_share_scratch);
    free(future_scratch);
    free(future_rank);
    free(source_state_offset);
    free(external_order);
    free(archive_order);
    free(image_order);
    if (external_payload_bytes)
        for (pl_u32 index = 0u; index < external_payload_count; ++index)
            free(external_payload_bytes[index]);
    free(external_payload);
    free(external_payload_bytes);
    if (archive)
        for (pl_u32 index = 0u; index < archive_count; ++index)
            close_release_archive(&archive[index]);
    free(archive_instance);
    free(archive);
    artifact_namespace_posix_close(&namespace);
    release_population_close(&release);
    return status ? 1 : 0;
}
