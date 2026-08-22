/* postlink-blocks -- prove direct-Wasm block closure over every x86 byte.
 *
 * Every mapped byte is a possible indirect target.  Valid pure coordinates
 * therefore run through the real block former, physical-SSA compactor and
 * Wasm encoder. Fault coordinates are ordinary homogeneous ABI functions.
 * Machine-barrier coordinates remain useful analysis rows, but are not
 * executable semantics: publication rejects them until the C semantic source
 * lowers each one to SSA or to a typed vm.wasm machine operation. The command
 * fails when even one coordinate cannot be represented; publication must
 * never defer that failure to a runtime interpreter.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/stat.h>
#include <time.h>

#include <postlink/postlink.h>

#define BLOCK_ARENA_BYTES (1024u * 1024u)
#define BLOCK_MAXIMUM_INSTRUCTIONS 64u
#define BLOCK_IDENTITY_CAPACITY (2u * 1024u * 1024u)
#define BLOCK_HASH_SLOTS (2u * BLOCK_IDENTITY_CAPACITY)
#define BLOCK_BODY_CAPACITY (64u * 1024u)
#define EXAMPLE_COUNT 8u
#define MODULE_BODY_TARGET (1024u * 1024u)
#define MODULE_FUNCTION_LIMIT 1024u
#define PUBLISH_PATH_BYTES 1024u

typedef struct {
    pl_u64 rip;
    int status;
} closure_example;

typedef struct {
    pl_x86_block_builder builder;
    pl_u64 coordinates;
    pl_u64 fault_coordinates;
    pl_u64 barrier_coordinates;
    pl_u64 direct_coordinates;
    pl_u64 conditional_blocks;
    pl_u64 dynamic_blocks;
    pl_u64 static_blocks;
    pl_u64 successor_in_image;
    pl_u64 successor_outside_image;
    pl_u64 source_instructions;
    pl_u64 physical_work;
    pl_u64 physical_span;
    pl_u64 lower_failures;
    pl_u64 wasm_failures;
    pl_u32 maximum_source_instructions;
    pl_u32 maximum_work;
    pl_u32 maximum_span;
    pl_u64 opcode_coordinates[PL_OPCODE_COUNT];
    closure_example examples[EXAMPLE_COUNT];
    pl_u32 example_count;
} block_catalog;

typedef struct {
    pl_u8 digest[PL_SHA256_BYTES];
    pl_u32 bytes;
} body_identity;

typedef struct {
    pl_u32 states;
    pl_u32 edges;
    pl_u32 zero_degree;
    pl_u32 two_degree;
    pl_u32 resolver_edges;
    pl_u64 raw_bytes;
    pl_u32 state_pages;
    pl_u32 edge_pages;
    pl_u64 delivery_bytes;
    pl_u8 delivery_identity[PL_SHA256_BYTES];
} residual_metrics;

typedef struct {
    const char *directory;
    char pack_path[PUBLISH_PATH_BYTES];
    char pack_temporary[PUBLISH_PATH_BYTES];
    FILE *pack;
    pl_u64 pack_bytes;
    pl_delivery_locator *locators;
    pl_u32 locator_count;
    pl_u32 locator_capacity;
    pl_u32 *locator_slots;
    pl_u32 locator_slot_count;
    pl_u8 *body_storage;
    pl_u32 body_used;
    pl_wasm_function_body bodies[MODULE_FUNCTION_LIMIT];
    pl_u32 body_count;
    pl_u32 first_function;
    pl_executable_module *modules;
    pl_u32 module_count;
    pl_u32 module_capacity;
    pl_executable_resource *resources;
    pl_u32 resource_count;
    pl_u32 resource_capacity;
} projection_publisher;

static pl_u64 digest_hash(const pl_u8 digest[PL_SHA256_BYTES]);
static int same_digest(const pl_u8 *left, const pl_u8 *right);

static double wall_seconds(void)
{
    struct timespec value;
    return timespec_get(&value, TIME_UTC) == TIME_UTC
         ? (double)value.tv_sec + (double)value.tv_nsec / 1000000000.0
         : 0.0;
}

static void report_phase(const char *label, double *prior)
{
    double now = wall_seconds();
    if (now && *prior)
        fprintf(stderr, "phase %-24s %.3f s\n", label, now - *prior);
    *prior = now;
}

static int make_directory(const char *path)
{
    return mkdir(path, 0777) == 0 || errno == EEXIST;
}

static int projection_locator_rehash(projection_publisher *publisher,
                                     pl_u32 slots)
{
    if (!publisher || slots < 2u || (slots & (slots - 1u)))
        return PL_ERROR_EXECUTABLE_RANGE;
    pl_u32 *table = calloc(slots, sizeof *table);
    if (!table) return PL_ERROR_EXECUTABLE_RANGE;
    for (pl_u32 rank = 0u; rank < publisher->locator_count; ++rank) {
        pl_u32 slot = (pl_u32)digest_hash(
            publisher->locators[rank].digest) & (slots - 1u);
        while (table[slot]) slot = (slot + 1u) & (slots - 1u);
        table[slot] = rank + 1u;
    }
    free(publisher->locator_slots);
    publisher->locator_slots = table;
    publisher->locator_slot_count = slots;
    return 0;
}

static int projection_locator_reserve(projection_publisher *publisher)
{
    if (publisher->locator_count == publisher->locator_capacity) {
        pl_u32 grown = publisher->locator_capacity * 2u;
        pl_delivery_locator *values = realloc(
            publisher->locators, (size_t)grown * sizeof *values);
        if (!values) return PL_ERROR_EXECUTABLE_RANGE;
        publisher->locators = values;
        publisher->locator_capacity = grown;
    }
    if ((pl_u64)(publisher->locator_count + 1u) * 2u
            > publisher->locator_slot_count)
        return projection_locator_rehash(
            publisher, publisher->locator_slot_count * 2u);
    return 0;
}

static int publish_object(projection_publisher *publisher,
                          const pl_u8 *bytes, pl_u32 length,
                          pl_u8 digest[PL_SHA256_BYTES])
{
    if (!publisher || !bytes || !length || !digest)
        return PL_ERROR_EXECUTABLE;
    pl_sha256_digest(bytes, length, digest);
    pl_u32 slot = (pl_u32)digest_hash(digest)
                & (publisher->locator_slot_count - 1u);
    while (publisher->locator_slots[slot]) {
        pl_delivery_locator *prior = &publisher->locators[
            publisher->locator_slots[slot] - 1u];
        if (same_digest(prior->digest, digest))
            return prior->bytes == length ? 0 : PL_ERROR_INDEX_DIGEST;
        slot = (slot + 1u) & (publisher->locator_slot_count - 1u);
    }
    int status = projection_locator_reserve(publisher);
    if (status) return status;
    slot = (pl_u32)digest_hash(digest)
         & (publisher->locator_slot_count - 1u);
    while (publisher->locator_slots[slot])
        slot = (slot + 1u) & (publisher->locator_slot_count - 1u);
    if (fwrite(bytes, 1u, length, publisher->pack) != length)
        return PL_ERROR_EXECUTABLE;
    pl_delivery_locator *locator =
        &publisher->locators[publisher->locator_count];
    memcpy(locator->digest, digest, PL_SHA256_BYTES);
    locator->offset = publisher->pack_bytes;
    locator->bytes = length;
    publisher->pack_bytes += length;
    publisher->locator_slots[slot] = ++publisher->locator_count;
    return 0;
}

static int publish_named(const projection_publisher *publisher,
                         const char *name,
                         const pl_u8 *bytes, pl_u32 length)
{
    if (!publisher || !name || !bytes || !length)
        return PL_ERROR_EXECUTABLE;
    char path[PUBLISH_PATH_BYTES];
    int path_bytes = snprintf(
        path, sizeof path, "%s/%s", publisher->directory, name);
    if (path_bytes < 0 || (size_t)path_bytes >= sizeof path)
        return PL_ERROR_EXECUTABLE_RANGE;
    char temporary[PUBLISH_PATH_BYTES];
    int temporary_bytes = snprintf(
        temporary, sizeof temporary, "%s.part", path);
    if (temporary_bytes < 0
            || (size_t)temporary_bytes >= sizeof temporary)
        return PL_ERROR_EXECUTABLE_RANGE;
    FILE *target = fopen(temporary, "wb");
    if (!target) return PL_ERROR_EXECUTABLE;
    size_t written = fwrite(bytes, 1u, length, target);
    int failed = written != length || fclose(target) != 0;
    if (!failed && rename(temporary, path) != 0) failed = 1;
    if (failed) (void)remove(temporary);
    return failed ? PL_ERROR_EXECUTABLE : 0;
}

static int projection_publisher_open(projection_publisher *publisher,
                                     const char *directory)
{
    if (!publisher || !directory || !directory[0]
            || !make_directory(directory))
        return PL_ERROR_EXECUTABLE;
    *publisher = (projection_publisher){ 0 };
    publisher->directory = directory;
    int bytes = snprintf(
        publisher->pack_path, sizeof publisher->pack_path,
        "%s/objects.pack", directory);
    int temporary_bytes = snprintf(
        publisher->pack_temporary, sizeof publisher->pack_temporary,
        "%s/objects.pack.part", directory);
    if (bytes < 0 || (size_t)bytes >= sizeof publisher->pack_path
            || temporary_bytes < 0
            || (size_t)temporary_bytes >= sizeof publisher->pack_temporary)
        return PL_ERROR_EXECUTABLE_RANGE;
    publisher->pack = fopen(publisher->pack_temporary, "wb");
    publisher->body_storage = malloc(MODULE_BODY_TARGET);
    publisher->locator_capacity = 4096u;
    publisher->locators = malloc(
        (size_t)publisher->locator_capacity * sizeof *publisher->locators);
    publisher->locator_slot_count = 8192u;
    publisher->locator_slots = calloc(
        publisher->locator_slot_count, sizeof *publisher->locator_slots);
    publisher->module_capacity = 256u;
    publisher->modules = malloc(
        (size_t)publisher->module_capacity * sizeof *publisher->modules);
    publisher->resource_capacity = 4096u;
    publisher->resources = malloc(
        (size_t)publisher->resource_capacity * sizeof *publisher->resources);
    return publisher->pack && publisher->body_storage
        && publisher->locators && publisher->locator_slots
        && publisher->modules && publisher->resources
         ? 0 : PL_ERROR_WASM_RANGE;
}

static int projection_flush_module(projection_publisher *publisher)
{
    if (!publisher || !publisher->body_count) return 0;
    pl_u32 measured = 0u;
    int status = pl_wasm_body_module_measure(
        publisher->bodies, publisher->body_count, &measured);
    pl_u8 *module = status || !measured ? NULL : malloc(measured);
    pl_u32 written = 0u;
    if (!status && !module) status = PL_ERROR_WASM_RANGE;
    if (!status)
        status = pl_wasm_body_module_write(
            publisher->bodies, publisher->body_count,
            module, measured, &written);
    if (!status && written != measured) status = PL_ERROR_WASM;
    if (!status && publisher->module_count == publisher->module_capacity) {
        pl_u32 grown = publisher->module_capacity * 2u;
        pl_executable_module *resized = realloc(
            publisher->modules,
            (size_t)grown * sizeof *publisher->modules);
        if (!resized) status = PL_ERROR_WASM_RANGE;
        else {
            publisher->modules = resized;
            publisher->module_capacity = grown;
        }
    }
    if (!status) {
        pl_executable_module *row =
            &publisher->modules[publisher->module_count];
        *row = (pl_executable_module){
            .first_function = publisher->first_function,
            .payload_bytes = written,
            .function_count = publisher->body_count,
            .flags = PL_EXECUTABLE_MODULE_WASM32,
        };
        status = publish_object(publisher, module, written, row->digest);
        if (!status) ++publisher->module_count;
    }
    free(module);
    if (!status) {
        publisher->body_used = 0u;
        publisher->body_count = 0u;
    }
    return status;
}

static int projection_add_body(projection_publisher *publisher,
                               pl_u32 function_rank,
                               const pl_u8 *bytes, pl_u32 length)
{
    if (!publisher || !bytes || !length || length > MODULE_BODY_TARGET)
        return PL_ERROR_WASM_RANGE;
    if (publisher->body_count
            && (publisher->body_count == MODULE_FUNCTION_LIMIT
                || length > MODULE_BODY_TARGET - publisher->body_used)) {
        int status = projection_flush_module(publisher);
        if (status) return status;
    }
    if (!publisher->body_count) publisher->first_function = function_rank;
    if (function_rank != publisher->first_function + publisher->body_count)
        return PL_ERROR_WASM_RANGE;
    pl_u8 *target = publisher->body_storage + publisher->body_used;
    for (pl_u32 index = 0u; index < length; ++index)
        target[index] = bytes[index];
    publisher->bodies[publisher->body_count] =
        (pl_wasm_function_body){ target, length };
    publisher->body_used += length;
    ++publisher->body_count;
    return 0;
}

static int publish_index_object(
    void *context, const pl_u8 digest[PL_SHA256_BYTES],
    const pl_u8 *bytes, pl_u32 length)
{
    projection_publisher *publisher = context;
    pl_u8 observed[PL_SHA256_BYTES];
    int status = publish_object(publisher, bytes, length, observed);
    if (status) return status;
    pl_u32 different = 0u;
    for (pl_u32 index = 0u; index < PL_SHA256_BYTES; ++index)
        different |= (pl_u32)(observed[index] ^ digest[index]);
    return different ? PL_ERROR_INDEX_DIGEST : 0;
}

static int projection_add_resource(
    projection_publisher *publisher, pl_u64 key, pl_u32 kind,
    pl_u32 projection_argument, const pl_u8 *bytes, pl_u32 length)
{
    if (!publisher || !bytes || !length) return PL_ERROR_EXECUTABLE_RESOURCE;
    if (publisher->resource_count == publisher->resource_capacity) {
        pl_u32 grown = publisher->resource_capacity * 2u;
        pl_executable_resource *resized = realloc(
            publisher->resources,
            (size_t)grown * sizeof *publisher->resources);
        if (!resized) return PL_ERROR_EXECUTABLE_RESOURCE;
        publisher->resources = resized;
        publisher->resource_capacity = grown;
    }
    pl_executable_resource *resource =
        &publisher->resources[publisher->resource_count];
    *resource = (pl_executable_resource){
        .physical_address = key,
        .object_bytes = length,
        .mapped_bytes = PL_EXECUTABLE_PAGE_BYTES,
        .page_bytes = PL_EXECUTABLE_PAGE_BYTES,
        .kind = kind,
        .flags = PL_EXECUTABLE_RESOURCE_READ_ONLY,
        .projection_argument = projection_argument,
    };
    int status = publish_object(publisher, bytes, length, resource->digest);
    if (!status) ++publisher->resource_count;
    return status;
}

static int compare_resources(const void *left, const void *right)
{
    const pl_executable_resource *a = left;
    const pl_executable_resource *b = right;
    if (a->physical_address < b->physical_address) return -1;
    if (a->physical_address > b->physical_address) return 1;
    if (a->key_minor < b->key_minor) return -1;
    return a->key_minor > b->key_minor;
}

static int projection_finish_resources(projection_publisher *publisher,
                                       pl_index_ref *root)
{
    if (!publisher || !publisher->resource_count || !root)
        return PL_ERROR_EXECUTABLE_RESOURCE;
    qsort(publisher->resources, publisher->resource_count,
          sizeof *publisher->resources, compare_resources);
    pl_u8 *rows = malloc(
        (size_t)publisher->resource_count * PL_EXECUTABLE_RESOURCE_BYTES);
    pl_index_ref *references = malloc(
        (size_t)publisher->resource_count * sizeof *references);
    pl_u8 *node = malloc(PL_INDEX_NODE_BYTES);
    int status = !rows || !references || !node
        ? PL_ERROR_INDEX_RANGE : 0;
    for (pl_u32 rank = 0u; !status && rank < publisher->resource_count;
         ++rank) {
        if (rank && publisher->resources[rank - 1u].physical_address
                == publisher->resources[rank].physical_address
                && publisher->resources[rank - 1u].key_minor
                   == publisher->resources[rank].key_minor)
            status = PL_ERROR_EXECUTABLE_RESOURCE;
        if (!status)
            status = pl_executable_resource_write(
                &publisher->resources[rank],
                rows + (size_t)rank * PL_EXECUTABLE_RESOURCE_BYTES);
    }
    if (!status)
        status = pl_index_build(
            rows, PL_EXECUTABLE_RESOURCE_BYTES, publisher->resource_count,
            references, publisher->resource_count, node,
            publish_index_object, publisher, root);
    if (!status) {
        pl_u8 root_bytes[PL_INDEX_REF_BYTES];
        status = pl_index_ref_write(root, root_bytes);
        if (!status)
            status = publish_named(
                publisher, "resources.index", root_bytes,
                sizeof root_bytes);
    }
    free(node);
    free(references);
    free(rows);
    return status;
}

static int projection_finish_bindings(
    projection_publisher *publisher, const pl_x86_image *image,
    const pl_closure_page *pages, pl_u32 page_count,
    pl_index_ref *root)
{
    if (!publisher || !image || !pages || !page_count || !root)
        return PL_ERROR_EXECUTABLE_BINDING;
    pl_u8 *rows = malloc(
        (size_t)page_count * PL_EXECUTABLE_BINDING_BYTES);
    pl_index_ref *references = malloc(
        (size_t)page_count * sizeof *references);
    pl_u8 *node = malloc(PL_INDEX_NODE_BYTES);
    pl_u8 *page = malloc(PL_EXECUTABLE_PAGE_BYTES);
    int status = !rows || !references || !node || !page
        ? PL_ERROR_INDEX_RANGE : 0;
    pl_x86_image_reader reader;
    if (!status) status = pl_x86_image_reader_open(&reader, image);
    for (pl_u32 rank = 0u; !status && rank < page_count; ++rank) {
        status = pl_x86_image_materialize(
            &reader, pages[rank].virtual_page,
            page, PL_EXECUTABLE_PAGE_BYTES);
        pl_executable_binding binding = {
            .virtual_page = pages[rank].virtual_page,
            .generation = pages[rank].generation,
            .source_offset = PL_EXECUTABLE_SOURCE_DERIVED,
            .source_bytes = PL_EXECUTABLE_PAGE_BYTES,
            .dispatch_function = 0u,
            .dispatch_argument = pages[rank].entry_page_rank,
        };
        if (!status)
            pl_sha256_digest(page, PL_EXECUTABLE_PAGE_BYTES, binding.digest);
        if (!status)
            status = pl_executable_binding_write(
                &binding,
                rows + (size_t)rank * PL_EXECUTABLE_BINDING_BYTES);
    }
    if (!status)
        status = pl_index_build(
            rows, PL_EXECUTABLE_BINDING_BYTES, page_count,
            references, page_count, node,
            publish_index_object, publisher, root);
    free(page);
    free(node);
    free(references);
    free(rows);
    return status;
}

static int projection_finish_modules(projection_publisher *publisher,
                                     pl_index_ref *root)
{
    int status = projection_flush_module(publisher);
    if (status || !publisher->module_count || !root)
        return status ? status : PL_ERROR_EXECUTABLE_MODULE;
    pl_u8 *rows = malloc(
        (size_t)publisher->module_count * PL_EXECUTABLE_MODULE_BYTES);
    pl_index_ref *references = malloc(
        (size_t)publisher->module_count * sizeof *references);
    pl_u8 *node = malloc(PL_INDEX_NODE_BYTES);
    if (!rows || !references || !node) status = PL_ERROR_INDEX_RANGE;
    for (pl_u32 rank = 0u; !status && rank < publisher->module_count;
         ++rank)
        status = pl_executable_module_write(
            &publisher->modules[rank],
            rows + (size_t)rank * PL_EXECUTABLE_MODULE_BYTES);
    if (!status)
        status = pl_index_build(
            rows, PL_EXECUTABLE_MODULE_BYTES, publisher->module_count,
            references, publisher->module_count, node,
            publish_index_object, publisher, root);
    free(node);
    free(references);
    free(rows);
    return status;
}

static int compare_locators(const void *left, const void *right)
{
    const pl_delivery_locator *a = left;
    const pl_delivery_locator *b = right;
    return memcmp(a->digest, b->digest, PL_SHA256_BYTES);
}

static int projection_publisher_finish(projection_publisher *publisher)
{
    if (!publisher || !publisher->pack || !publisher->locator_count
            || publisher->locator_count
               > (0xffffffffu - PL_DELIVERY_HEADER_BYTES)
                 / PL_DELIVERY_ROW_BYTES)
        return PL_ERROR_EXECUTABLE;
    int status = fclose(publisher->pack) == 0
               ? 0 : PL_ERROR_EXECUTABLE;
    publisher->pack = NULL;
    if (!status && rename(
            publisher->pack_temporary, publisher->pack_path) != 0)
        status = PL_ERROR_EXECUTABLE;
    qsort(publisher->locators, publisher->locator_count,
          sizeof *publisher->locators, compare_locators);
    pl_u32 bytes = PL_DELIVERY_HEADER_BYTES
                 + publisher->locator_count * PL_DELIVERY_ROW_BYTES;
    pl_u8 *index = status ? NULL : calloc(bytes, 1u);
    if (!status && !index) status = PL_ERROR_EXECUTABLE_RANGE;
    if (!status) {
        pl_u32 written = 0u;
        status = pl_delivery_index_write(
            publisher->locators, publisher->locator_count,
            publisher->pack_bytes, index, bytes, &written);
        if (!status && written != bytes) status = PL_ERROR_EXECUTABLE;
        if (!status)
            status = publish_named(
                publisher, "objects.index", index, bytes);
    }
    free(index);
    return status;
}

static void projection_publisher_close(projection_publisher *publisher)
{
    if (!publisher) return;
    if (publisher->pack) (void)fclose(publisher->pack);
    free(publisher->locator_slots);
    free(publisher->locators);
    free(publisher->modules);
    free(publisher->resources);
    free(publisher->body_storage);
    publisher->modules = NULL;
    publisher->resources = NULL;
    publisher->body_storage = NULL;
    publisher->locator_slots = NULL;
    publisher->locators = NULL;
    publisher->pack = NULL;
}

static pl_u64 digest_hash(const pl_u8 digest[PL_SHA256_BYTES])
{
    pl_u64 hash = 0xcbf29ce484222325ull;
    for (pl_u32 index = 0u; index < PL_SHA256_BYTES; ++index)
        hash = (hash ^ digest[index]) * 0x100000001b3ull;
    return hash;
}

static int same_digest(const pl_u8 *left, const pl_u8 *right)
{
    pl_u32 difference = 0u;
    for (pl_u32 index = 0u; index < PL_SHA256_BYTES; ++index)
        difference |= (pl_u32)(left[index] ^ right[index]);
    return difference == 0u;
}

static int measure_residual_graph(
    block_catalog *catalog, const pl_u64 *representatives,
    pl_u32 residual_count, const pl_closure_page *pages,
    pl_u32 page_count, const pl_entry_map *entry_map,
    const pl_u32 *kernel_ranks, pl_u32 transfer_count, pl_u32 kernel_count,
    residual_metrics *metrics, projection_publisher *publisher)
{
    if (!catalog || !representatives || !residual_count || !pages
            || !page_count || !entry_map || !kernel_ranks || !transfer_count
            || !kernel_count
            || !metrics
            || residual_count > 0x7fffffffu)
        return PL_ERROR_RESIDUAL;
    pl_u32 edge_capacity = residual_count * 2u;
    pl_u32 word_capacity = residual_count / 64u
                         + (residual_count % 64u != 0u);
    pl_u32 *kernels = malloc((size_t)residual_count * sizeof *kernels);
    pl_u64 *zero_bits = malloc((size_t)word_capacity * sizeof *zero_bits);
    pl_u64 *two_bits = malloc((size_t)word_capacity * sizeof *two_bits);
    pl_u32 *zero_prefix = malloc(
        ((size_t)word_capacity + 1u) * sizeof *zero_prefix);
    pl_u32 *two_prefix = malloc(
        ((size_t)word_capacity + 1u) * sizeof *two_prefix);
    pl_u32 *edge_next = malloc((size_t)edge_capacity * sizeof *edge_next);
    pl_i32 *edge_delta = malloc(
        (size_t)edge_capacity * sizeof *edge_delta);
    if (!kernels || !zero_bits || !two_bits || !zero_prefix || !two_prefix
            || !edge_next || !edge_delta) {
        free(edge_delta); free(edge_next);
        free(two_prefix); free(zero_prefix);
        free(two_bits); free(zero_bits); free(kernels);
        return PL_ERROR_RESIDUAL_CAPACITY;
    }
    pl_residual_builder builder;
    int status = pl_residual_builder_open(
        &builder, kernels, residual_count, zero_bits, two_bits,
        zero_prefix, two_prefix, word_capacity,
        edge_next, edge_delta, edge_capacity);
    for (pl_u32 residual = 0u; !status && residual < residual_count;
         ++residual) {
        pl_x86_block block;
        status = pl_x86_block_lower(
            &catalog->builder.frontend, representatives[residual],
            &catalog->builder.formation, &block);
        pl_u32 transfer = 0u;
        if (!status)
            status = pl_x86_block_intern(
                &catalog->builder, &block, &transfer);
        if (!status && transfer >= transfer_count)
            status = PL_ERROR_RESIDUAL;
        pl_u32 degree = block.kind == PL_X86_BLOCK_DIRECT
                     && !block.dynamic_target ? block.successor_count : 0u;
        pl_u32 next[2] = {
            PL_RESIDUAL_RESOLVE, PL_RESIDUAL_RESOLVE,
        };
        pl_i32 delta[2] = { 0, 0 };
        for (pl_u32 arm = 0u; !status && arm < degree; ++arm) {
            pl_i64 wide_delta =
                (pl_i64)(block.successor[arm] - block.start);
            if (wide_delta < (-2147483647ll - 1ll)
                    || wide_delta > 2147483647ll) {
                status = PL_ERROR_RESIDUAL;
                break;
            }
            delta[arm] = (pl_i32)wide_delta;
            if (!pl_x86_frontend_contains(
                    &catalog->builder.frontend, block.successor[arm]))
                continue;
            status = pl_closure_lookup(
                pages, page_count, entry_map,
                block.successor[arm], &next[arm]);
        }
        pl_u32 admitted = 0u;
        if (!status)
            status = pl_residual_add(
                &builder, kernel_ranks[transfer], degree,
                next, delta, &admitted);
        if (!status && admitted != residual) status = PL_ERROR_RESIDUAL;
    }
    pl_residual_graph graph;
    pl_residual_page_writer page_writer;
    if (!status)
        status = pl_residual_finish(
            &builder, kernel_count, &graph);
    if (!status)
        status = pl_residual_page_writer_open(&page_writer, &graph);
    if (!status) {
        pl_u32 resolver_edges = 0u;
        for (pl_u32 edge = 0u; edge < graph.edge_count; ++edge)
            resolver_edges += graph.edge_next[edge] == PL_RESIDUAL_RESOLVE;
        metrics->states = graph.state_count;
        metrics->edges = graph.edge_count;
        metrics->zero_degree = graph.zero_prefix[graph.word_count];
        metrics->two_degree = graph.two_prefix[graph.word_count];
        metrics->resolver_edges = resolver_edges;
        metrics->raw_bytes =
            (pl_u64)graph.state_count * sizeof(pl_u32)
          + (pl_u64)graph.word_count * 2u * sizeof(pl_u64)
          + ((pl_u64)graph.word_count + 1u) * 2u * sizeof(pl_u32)
          + (pl_u64)graph.edge_count
            * (sizeof(pl_u32) + sizeof(pl_i32));
        metrics->state_pages = graph.state_count
            / PL_RESIDUAL_STATE_PAGE_STATES
            + (graph.state_count % PL_RESIDUAL_STATE_PAGE_STATES != 0u);
        metrics->edge_pages = graph.edge_count
            / PL_RESIDUAL_EDGE_PAGE_EDGES
            + (graph.edge_count % PL_RESIDUAL_EDGE_PAGE_EDGES != 0u);
        metrics->delivery_bytes =
            (pl_u64)metrics->state_pages * PL_RESIDUAL_STATE_PAGE_USED
          + (pl_u64)metrics->edge_pages * PL_RESIDUAL_EDGE_PAGE_USED;
        pl_u8 *page = malloc(PL_RESIDUAL_PAGE_BYTES);
        pl_sha256 delivery;
        if (!page) status = PL_ERROR_RESIDUAL_CAPACITY;
        else pl_sha256_open(&delivery);
        for (pl_u32 rank = 0u; !status && rank < metrics->state_pages;
             ++rank) {
            status = pl_residual_state_page_writer_write(
                &page_writer, rank, page);
            if (!status)
                status = pl_residual_state_page_open(
                    page, rank, graph.state_count, graph.edge_count,
                    graph.kernel_count);
            if (!status) {
                pl_u8 digest[PL_SHA256_BYTES];
                pl_sha256_digest(
                    page, PL_RESIDUAL_STATE_PAGE_USED, digest);
                pl_sha256_write(&delivery, digest, sizeof digest);
                if (publisher)
                    status = projection_add_resource(
                        publisher, pl_executable_residual_state_key(rank),
                        PL_EXECUTABLE_RESOURCE_RESIDUAL_STATE_PAGE, 0u,
                        page, PL_RESIDUAL_STATE_PAGE_USED);
            }
        }
        for (pl_u32 rank = 0u; !status && rank < metrics->edge_pages;
             ++rank) {
            status = pl_residual_edge_page_writer_write(
                &page_writer, rank, page);
            if (!status)
                status = pl_residual_edge_page_open(
                    page, rank, graph.state_count, graph.edge_count);
            if (!status) {
                pl_u8 digest[PL_SHA256_BYTES];
                pl_sha256_digest(
                    page, PL_RESIDUAL_EDGE_PAGE_USED, digest);
                pl_sha256_write(&delivery, digest, sizeof digest);
                if (publisher)
                    status = projection_add_resource(
                        publisher, pl_executable_residual_edge_key(rank),
                        PL_EXECUTABLE_RESOURCE_RESIDUAL_EDGE_PAGE, 0u,
                        page, PL_RESIDUAL_EDGE_PAGE_USED);
            }
        }
        if (!status)
            pl_sha256_close(&delivery, metrics->delivery_identity);
        free(page);
    }
    free(edge_delta); free(edge_next);
    free(two_prefix); free(zero_prefix);
    free(two_bits); free(zero_bits); free(kernels);
    return status;
}

static void remember_failure(block_catalog *catalog, pl_u64 rip, int status)
{
    if (catalog->example_count == EXAMPLE_COUNT) return;
    closure_example *example = &catalog->examples[catalog->example_count++];
    example->rip = rip;
    example->status = status;
}

static int terminal_wasm(const pl_x86_instruction *instruction,
                         const pl_x86_block *block, pl_wasm_block *out)
{
    out->plan = &block->plan;
    out->next_rip = block->kind == PL_X86_BLOCK_FAULT
                  && !(instruction->flags & PL_X86_INSTRUCTION_TRAP_AFTER)
                  ? instruction->rip : block->end;
    out->result_kind = block->kind == PL_X86_BLOCK_FAULT
                     ? PL_VM_FAULT : PL_VM_BARRIER;
    out->result_payload = block->kind == PL_X86_BLOCK_FAULT
                        ? block->trap_vector : 0u;
    out->next_rip_operand.kind = PL_OPERAND_CONST;
    out->next_rip_operand.value = out->next_rip;
    out->branch_predicate.kind = PL_OPERAND_CONST;
    out->branch_predicate.value = 1u;
    out->alternate_rip = 0u;
    out->alternate_result_kind = PL_VM_DIRECT;
    out->alternate_result_payload = 0u;
    out->next_rip_relative = 0u;
    out->alternate_rip_relative = 0u;
    out->has_dynamic_rip = 0u;
    out->has_branch_predicate = 0u;
    out->fault_predicate.kind = PL_OPERAND_CONST;
    out->fault_predicate.value = 0u;
    out->machine_value.kind = PL_OPERAND_CONST;
    out->machine_value.value = 0u;
    out->has_fault_predicate = 0u;
    out->fault_vector = block->trap_vector;
    out->recurrence_local = 0u;
    out->recurrence_bits = 0u;
    out->recurrence_source_instructions = 0u;
    out->machine_operation = instruction->machine_operation;
    out->machine_argument = instruction->machine_argument;
    return 0;
}

static int catalog_block(const pl_x86_instruction *instruction, void *opaque)
{
    block_catalog *catalog = opaque;
    ++catalog->coordinates;

    pl_x86_block block;
    int status = pl_x86_block_lower(
        &catalog->builder.frontend, instruction->rip,
        &catalog->builder.formation, &block);
    if (status) {
        ++catalog->lower_failures;
        remember_failure(catalog, instruction->rip, status);
        return 0;
    }
    pl_u32 function_rank = 0u;
    status = pl_x86_block_intern(
        &catalog->builder, &block, &function_rank);
    if (status) {
        ++catalog->lower_failures;
        remember_failure(catalog, instruction->rip, status);
        return 0;
    }

    if (block.kind == PL_X86_BLOCK_DIRECT) {
        ++catalog->direct_coordinates;
        if (block.dynamic_target) ++catalog->dynamic_blocks;
        else if (block.has_predicate) ++catalog->conditional_blocks;
        else ++catalog->static_blocks;
        for (pl_u32 index = 0u; index < block.successor_count; ++index) {
            if (pl_x86_frontend_contains(
                    &catalog->builder.frontend, block.successor[index])) {
                ++catalog->successor_in_image;
            } else {
                ++catalog->successor_outside_image;
            }
        }
    } else {
        if (block.kind == PL_X86_BLOCK_FAULT)
            ++catalog->fault_coordinates;
        else {
            ++catalog->barrier_coordinates;
            ++catalog->wasm_failures;
            remember_failure(
                catalog, instruction->rip, PL_ERROR_WASM_UNSUPPORTED);
        }
    }
    catalog->source_instructions += block.instruction_count;
    catalog->physical_work += block.plan.node_count;
    catalog->physical_span += block.plan.span;
    for (pl_u32 index = 0u; index < block.plan.node_count; ++index)
        if (block.plan.nodes[index].opcode < PL_OPCODE_COUNT)
            ++catalog->opcode_coordinates[block.plan.nodes[index].opcode];
    if (block.instruction_count > catalog->maximum_source_instructions)
        catalog->maximum_source_instructions = block.instruction_count;
    if (block.plan.node_count > catalog->maximum_work)
        catalog->maximum_work = block.plan.node_count;
    if (block.plan.span > catalog->maximum_span)
        catalog->maximum_span = block.plan.span;
    return 0;
}

static int load_file(const char *path, pl_u8 **bytes_out, pl_u64 *size_out)
{
    FILE *handle = fopen(path, "rb");
    if (!handle) return -1;
    if (fseek(handle, 0, SEEK_END)) { fclose(handle); return -1; }
    long size = ftell(handle);
    if (size <= 0 || fseek(handle, 0, SEEK_SET)) {
        fclose(handle);
        return -1;
    }
    pl_u8 *bytes = malloc((size_t)size);
    if (!bytes || fread(bytes, 1u, (size_t)size, handle) != (size_t)size) {
        free(bytes);
        fclose(handle);
        return -1;
    }
    fclose(handle);
    *bytes_out = bytes;
    *size_out = (pl_u64)size;
    return 0;
}

static int shard_bounds(pl_u64 total, pl_u32 index, pl_u32 count,
                        pl_u64 *begin, pl_u64 *end)
{
    if (!count || index >= count) return -1;
    pl_u64 width = total / count;
    pl_u64 wider = total % count;
    *begin = width * index + (index < wider ? index : wider);
    *end = *begin + width + (index < wider ? 1u : 0u);
    return 0;
}

static int slots_for(pl_u32 capacity, pl_u32 *slots)
{
    pl_u32 value = 1u;
    while (value <= capacity) {
        if (value > 0x7fffffffu) return -1;
        value <<= 1u;
    }
    *slots = value;
    return 0;
}

static void print_top_opcodes(const char *label,
                              const pl_u64 counts[PL_OPCODE_COUNT])
{
    pl_u8 selected[PL_OPCODE_COUNT];
    for (pl_u32 index = 0u; index < PL_OPCODE_COUNT; ++index)
        selected[index] = 0u;
    printf("%s\n", label);
    for (pl_u32 rank = 0u; rank < 24u; ++rank) {
        pl_u32 best = PL_OPCODE_COUNT;
        pl_u64 value = 0u;
        for (pl_u32 opcode = 0u; opcode < PL_OPCODE_COUNT; ++opcode)
            if (!selected[opcode] && counts[opcode] > value) {
                best = opcode;
                value = counts[opcode];
            }
        if (best == PL_OPCODE_COUNT || !value) break;
        selected[best] = 1u;
        printf("  opcode %-3u     %llu\n", best,
               (unsigned long long)value);
    }
}

static int check_wasm_bodies(block_catalog *catalog)
{
    if (!catalog) return PL_ERROR_WASM;
    for (pl_u32 rank = 0u;
         rank < catalog->builder.identity_count; ++rank) {
        pl_u64 rip = catalog->builder.identities[rank].representative;
        pl_x86_instruction instruction = { 0 };
        pl_x86_block block = { 0 };
        pl_wasm_block emitted;
        int status = pl_x86_frontend_decode(
            &catalog->builder.frontend, rip, &instruction);
        if (!status)
            status = pl_x86_block_lower(
                &catalog->builder.frontend, rip,
                &catalog->builder.formation, &block);
        if (!status)
            status = block.kind == PL_X86_BLOCK_DIRECT
                   ? pl_x86_block_kernel_wasm(&block, &emitted)
                   : terminal_wasm(&instruction, &block, &emitted);
        pl_u32 body_bytes = 0u;
        if (!status)
            status = pl_wasm_block_measure(&emitted, 0u, &body_bytes);
        pl_u32 shape_bytes = 0u, parameter_count = 0u;
        if (!status)
            status = pl_wasm_block_parameterized_measure(
                &emitted, 0u, &shape_bytes, &parameter_count);
        if (!status && (body_bytes > BLOCK_BODY_CAPACITY
                || shape_bytes > BLOCK_BODY_CAPACITY))
            status = PL_ERROR_WASM_RANGE;
        if (!status && parameter_count > 255u)
            status = PL_ERROR_INSTANTIATION_CAPACITY;
        if (status) {
            fprintf(stderr,
                    "cannot emit body rank=%u rip=0x%016llx kind=%u "
                    "semantic=%u machine=%u argument=0x%016llx "
                    "locals=%u stack=%u status=%d\n",
                    rank, (unsigned long long)rip, block.kind,
                    instruction.operation, block.machine_operation,
                    (unsigned long long)block.machine_argument,
                    block.plan.local_count, block.plan.stack_count, status);
            return status;
        }
    }
    printf("emission completeness: green (%u function classes)\n",
           catalog->builder.identity_count);
    return 0;
}

int main(int argc, char **argv)
{
    double phase_started = wall_seconds();
    pl_u32 shard_index = 0u, shard_count = 1u;
    int residual_mode = argc == 3 && !strcmp(argv[2], "--residual");
    int emission_check = argc == 3
                      && !strcmp(argv[2], "--emission-check");
    const char *output_directory = argc == 4
        && !strcmp(argv[2], "--output") ? argv[3] : NULL;
    if (output_directory) residual_mode = 1;
    char trailing = 0;
    if (argc == 3 && !residual_mode && !emission_check) {
        unsigned parsed_index = 0u, parsed_count = 0u;
        if (sscanf(argv[2], "%u/%u%c", &parsed_index, &parsed_count,
                   &trailing) != 2
                || parsed_index > 0xffffffffu
                || parsed_count > 0xffffffffu) {
            fprintf(stderr, "invalid shard %s\n", argv[2]);
            return 2;
        }
        shard_index = (pl_u32)parsed_index;
        shard_count = (pl_u32)parsed_count;
    }
    if (argc < 2 || argc > 4 || (argc == 4 && !output_directory)) {
        fprintf(stderr,
                "usage: postlink-blocks LINKED-X86-ELF "
                "[INDEX/COUNT|--emission-check|--residual|"
                "--output DIRECTORY]\n");
        return 2;
    }
    pl_u8 *bytes = NULL;
    pl_u64 size = 0u;
    if (load_file(argv[1], &bytes, &size)) {
        fprintf(stderr, "cannot read %s\n", argv[1]);
        return 1;
    }
    pl_elf_image elf;
    int status = pl_elf_open(bytes, size, &elf);
    if (status) {
        fprintf(stderr, "%s is not a supported linked x86-64 ELF\n", argv[1]);
        free(bytes);
        return 1;
    }
    report_phase("catalog", &phase_started);

    pl_u32 map_count = 0u;
    status = pl_x86_elf_map_count(&elf, &map_count);
    pl_u32 map_capacity = status || map_count > 0x7fffffffu
                        ? 0u : map_count * 2u;
    if (!status && !map_capacity) status = PL_ERROR_X86_CAPACITY;
    pl_x86_map *maps = status ? NULL
                     : malloc((size_t)map_capacity * sizeof *maps);
    pl_u8 *first = malloc(BLOCK_ARENA_BYTES);
    pl_u8 *second = malloc(BLOCK_ARENA_BYTES);
    pl_u8 *compare_first = malloc(BLOCK_ARENA_BYTES);
    pl_u8 *compare_second = malloc(BLOCK_ARENA_BYTES);
    pl_x86_block_identity *identities = malloc(
        (size_t)BLOCK_IDENTITY_CAPACITY * sizeof *identities);
    pl_u32 *block_slots = malloc(
        (size_t)BLOCK_HASH_SLOTS * sizeof *block_slots);
    if (status || !maps || !first || !second || !compare_first
            || !compare_second || !identities || !block_slots) {
        fprintf(stderr, "cannot allocate bounded block workspace\n");
        free(block_slots);
        free(identities);
        free(compare_second);
        free(compare_first);
        free(second);
        free(first);
        free(maps);
        free(bytes);
        return 1;
    }
    pl_x86_image image;
    status = pl_x86_image_from_elf_coordinates(
        &elf, 0u, 0u, PL_X86_ELF_VIRTUAL,
        maps, map_capacity, &image);
    if (!status && !pl_x86_image_contains(&image, image.entry))
        status = pl_x86_image_from_elf_aliases(
            &elf, 0u, 0u, 0u, maps, map_capacity, &image);
    block_catalog catalog = { 0 };
    pl_x86_block_workspace formation = {
        first, second, BLOCK_ARENA_BYTES, BLOCK_MAXIMUM_INSTRUCTIONS,
    };
    pl_x86_block_workspace comparison = {
        compare_first, compare_second, BLOCK_ARENA_BYTES,
        BLOCK_MAXIMUM_INSTRUCTIONS,
    };
    if (!status)
        status = pl_x86_block_builder_open(
            &catalog.builder, &image, &formation, &comparison,
            identities, BLOCK_IDENTITY_CAPACITY,
            block_slots, BLOCK_HASH_SLOTS);
    pl_u64 total_coordinates = 0u;
    for (pl_u32 index = 0u; !status && index < image.map_count; ++index) {
        if (total_coordinates > ~0ull - image.maps[index].memory_bytes)
            status = PL_ERROR_X86_CAPACITY;
        else
            total_coordinates += image.maps[index].memory_bytes;
    }
    pl_u64 shard_begin = 0u, shard_end = 0u;
    if (!status && shard_bounds(total_coordinates, shard_index, shard_count,
                                &shard_begin, &shard_end))
        status = PL_ERROR_X86_CAPACITY;
    pl_u64 coordinate_base = 0u;
    for (pl_u32 map_index = 0u; !status && map_index < image.map_count;
            ++map_index) {
        const pl_x86_map *map = &image.maps[map_index];
        pl_u64 map_end = coordinate_base + map->memory_bytes;
        /* Intersect in global-coordinate space before subtracting the map
         * base.  Subtracting first underflowed for every map strictly after a
         * shard and turned a few thousand requested coordinates into tens of
         * millions of bogus admissions. */
        if (shard_begin < map_end && coordinate_base < shard_end) {
            pl_u64 global_begin = shard_begin > coordinate_base
                                ? shard_begin : coordinate_base;
            pl_u64 global_end = shard_end < map_end ? shard_end : map_end;
            pl_u64 begin = global_begin - coordinate_base;
            pl_u64 end = global_end - coordinate_base;
            for (pl_u64 offset = begin; offset < end; ++offset) {
                pl_x86_instruction instruction;
                status = pl_x86_frontend_decode(
                    &catalog.builder.frontend,
                    map->address + offset, &instruction);
                if (status) break;
                status = catalog_block(&instruction, &catalog);
                if (status) break;
            }
        }
        coordinate_base = map_end;
    }
    if (!status && catalog.coordinates != shard_end - shard_begin)
        status = PL_ERROR_X86_CAPACITY;
    report_phase("coordinate catalog", &phase_started);
    if (status) {
        fprintf(stderr, "cannot catalog blocks: %d\n", status);
        free(block_slots);
        free(identities);
        free(compare_second);
        free(compare_first);
        free(second);
        free(first);
        free(maps);
        free(bytes);
        return 1;
    }

    /* An identity-plan machine barrier contains no x86 semantics. It is kept
     * in analysis mode so coverage can be ranked without fabricating a second
     * executor, but it can never cross the publication boundary. The semantic
     * importer/direct machine-operation lowerer must make this count zero. */
    if (output_directory && catalog.wasm_failures) {
        fprintf(stderr,
                "refusing to publish %llu machine-barrier coordinates "
                "without direct semantics\n",
                (unsigned long long)catalog.wasm_failures);
        for (pl_u32 index = 0u; index < catalog.example_count; ++index)
            fprintf(stderr,
                    "  missing semantic[%u] rip=0x%016llx status=%d\n",
                    index,
                    (unsigned long long)catalog.examples[index].rip,
                    catalog.examples[index].status);
        free(block_slots);
        free(identities);
        free(compare_second);
        free(compare_first);
        free(second);
        free(first);
        free(maps);
        free(bytes);
        return 1;
    }
    if (emission_check) {
        status = catalog.wasm_failures
               ? PL_ERROR_WASM_UNSUPPORTED : check_wasm_bodies(&catalog);
        free(block_slots);
        free(identities);
        free(compare_second);
        free(compare_first);
        free(second);
        free(first);
        free(maps);
        free(bytes);
        return status ? 1 : 0;
    }

    pl_u32 mapped_function_classes = catalog.builder.identity_count;
    pl_closure_report closure = { 0 };
    pl_closure_partition_report partition = { 0 };
    pl_entry_map entry_map = { 0 };
    pl_u64 entry_map_bytes = 0u;
    pl_closure_page *closure_pages = NULL;
    pl_u32 *partition_page_rows[2] = { NULL, NULL };
    pl_u32 *partition_tail_rows[2] = { NULL, NULL };
    pl_u32 *partition_tail_hash[2] = { NULL, NULL };
    pl_closure_transfer_edge *partition_edges = NULL;
    pl_u64 *partition_representatives = NULL;
    pl_u32 *partition_reverse_offsets = NULL;
    pl_u32 *partition_predecessors = NULL;
    pl_u32 *partition_classes = NULL;
    pl_u32 *partition_order = NULL;
    pl_u32 *partition_frontier = NULL;
    pl_u32 *partition_positions = NULL;
    pl_u32 *partition_class_starts = NULL;
    pl_u32 *partition_class_sizes = NULL;
    pl_u32 *partition_class_hits = NULL;
    pl_u32 *partition_touched = NULL;
    pl_u32 *partition_queue = NULL;
    pl_u8 *partition_queued = NULL;
    if (shard_count == 1u) {
        pl_u32 page_count = 0u;
        status = pl_closure_page_count(&image, &page_count);
        if (!status && page_count > 0xffffffffu / PL_ENTRY_PAGE_ROWS)
            status = PL_ERROR_CLOSURE_CAPACITY;
        pl_u32 tail_capacity = status ? 0u
            : page_count * PL_ENTRY_PAGE_ROWS;
        pl_u32 entry_slots = 0u;
        if (!status && slots_for(tail_capacity, &entry_slots))
            status = PL_ERROR_ENTRY_MAP_FULL;
        partition_page_rows[0] = status ? NULL : malloc(
            (size_t)tail_capacity * sizeof(pl_u32));
        partition_tail_rows[0] = status ? NULL : malloc(
            (size_t)tail_capacity * PL_ENTRY_TAIL_VALUES
            * sizeof(pl_u32));
        partition_tail_hash[0] = status ? NULL : malloc(
            (size_t)entry_slots * sizeof(pl_u32));
        closure_pages = status ? NULL : malloc(
            (size_t)page_count * sizeof *closure_pages);
        if (!status && (!partition_page_rows[0]
                || !partition_tail_rows[0] || !partition_tail_hash[0]
                || !closure_pages))
            status = PL_ERROR_CLOSURE_CAPACITY;
        pl_entry_map_builder entry_builder;
        if (!status)
            status = pl_entry_map_builder_open(
                &entry_builder, partition_page_rows[0], page_count,
                partition_tail_rows[0], tail_capacity,
                partition_tail_hash[0], entry_slots,
                BLOCK_IDENTITY_CAPACITY);
        if (!status)
            status = pl_closure_build(
                &image, pl_x86_block_rank_instruction, &catalog.builder,
                &entry_builder, closure_pages, page_count, &closure);
        if (!status) {
            entry_builder.function_count = catalog.builder.identity_count;
            pl_entry_map_finish(&entry_builder, &entry_map);
        }
        if (!status && residual_mode) {
            if (page_count > 0xffffffffu / PL_ENTRY_PAGE_VALUES)
                status = PL_ERROR_CLOSURE_CAPACITY;
            pl_u32 coordinate_capacity = status ? 0u
                : page_count * PL_ENTRY_PAGE_VALUES;
            pl_u32 predecessor_capacity = 0u;
            if (!status && coordinate_capacity > 0x7fffffffu)
                status = PL_ERROR_CLOSURE_CAPACITY;
            else if (!status)
                predecessor_capacity = coordinate_capacity * 2u;
            partition_page_rows[1] = status ? NULL : malloc(
                (size_t)tail_capacity * sizeof(pl_u32));
            partition_tail_rows[1] = status ? NULL : malloc(
                (size_t)tail_capacity * PL_ENTRY_TAIL_VALUES
                * sizeof(pl_u32));
            partition_tail_hash[1] = status ? NULL : malloc(
                (size_t)entry_slots * sizeof(pl_u32));
            partition_edges = status ? NULL : malloc(
                (size_t)BLOCK_IDENTITY_CAPACITY * sizeof *partition_edges);
            partition_representatives = status ? NULL : malloc(
                (size_t)coordinate_capacity * sizeof *partition_representatives);
            partition_reverse_offsets = status ? NULL : malloc(
                ((size_t)coordinate_capacity + 1u)
                * sizeof *partition_reverse_offsets);
            partition_predecessors = status ? NULL : malloc(
                (size_t)predecessor_capacity * sizeof *partition_predecessors);
            partition_classes = status ? NULL : malloc(
                (size_t)coordinate_capacity * sizeof *partition_classes);
            partition_order = status ? NULL : malloc(
                (size_t)coordinate_capacity * sizeof *partition_order);
            partition_frontier = status ? NULL : malloc(
                (size_t)coordinate_capacity * sizeof *partition_frontier);
            partition_positions = status ? NULL : malloc(
                (size_t)coordinate_capacity * sizeof *partition_positions);
            partition_class_starts = status ? NULL : malloc(
                (size_t)coordinate_capacity * sizeof *partition_class_starts);
            partition_class_sizes = status ? NULL : malloc(
                (size_t)coordinate_capacity * sizeof *partition_class_sizes);
            partition_class_hits = status ? NULL : malloc(
                (size_t)coordinate_capacity * sizeof *partition_class_hits);
            partition_touched = status ? NULL : malloc(
                (size_t)coordinate_capacity * sizeof *partition_touched);
            partition_queue = status ? NULL : malloc(
                (size_t)coordinate_capacity * 2u * sizeof *partition_queue);
            partition_queued = status ? NULL : malloc(
                (size_t)coordinate_capacity * sizeof *partition_queued);
            if (!status && (!partition_page_rows[1]
                    || !partition_tail_rows[1] || !partition_tail_hash[1]
                    || !partition_edges || !partition_representatives
                    || !partition_reverse_offsets || !partition_predecessors
                    || !partition_classes || !partition_order
                    || !partition_frontier || !partition_positions
                    || !partition_class_starts || !partition_class_sizes
                    || !partition_class_hits || !partition_touched
                    || !partition_queue || !partition_queued))
                status = PL_ERROR_CLOSURE_CAPACITY;
            pl_closure_partition_workspace workspace = {
                .page_rows = {
                    partition_page_rows[0], partition_page_rows[1],
                },
                .tail_rows = {
                    partition_tail_rows[0], partition_tail_rows[1],
                },
                .tail_hash = {
                    partition_tail_hash[0], partition_tail_hash[1],
                },
                .page_capacity = page_count,
                .tail_capacity = tail_capacity,
                .tail_hash_slots = entry_slots,
                .pages = closure_pages,
                .transfer_edges = partition_edges,
                .transfer_edge_capacity = BLOCK_IDENTITY_CAPACITY,
                .representatives = partition_representatives,
                .class_capacity = coordinate_capacity,
                .coordinate_capacity = coordinate_capacity,
                .predecessor_capacity = predecessor_capacity,
                .reverse_offsets = partition_reverse_offsets,
                .predecessors = partition_predecessors,
                .classes = partition_classes,
                .order = partition_order,
                .frontier = partition_frontier,
                .positions = partition_positions,
                .class_starts = partition_class_starts,
                .class_sizes = partition_class_sizes,
                .class_hits = partition_class_hits,
                .touched_classes = partition_touched,
                .split_queue = partition_queue,
                .queued_arms = partition_queued,
            };
            if (!status)
                status = pl_closure_partition(
                    &image, &catalog.builder, &workspace,
                    &entry_map, &closure, &partition);
        }
        if (!status) {
            entry_map_bytes = (pl_u64)entry_map.page_count
                            * PL_ENTRY_PAGE_ROWS * sizeof(pl_u32)
                          + (pl_u64)entry_map.tail_row_count
                            * PL_ENTRY_TAIL_VALUES * sizeof(pl_u32);
        }
        if (status) {
            fprintf(stderr,
                    "cannot build total transfer entry map: %d\n", status);
            free(partition_queued);
            free(partition_queue);
            free(partition_touched);
            free(partition_class_hits);
            free(partition_class_sizes);
            free(partition_class_starts);
            free(partition_positions);
            free(partition_frontier);
            free(partition_order);
            free(partition_classes);
            free(partition_predecessors);
            free(partition_reverse_offsets);
            free(partition_representatives);
            free(partition_edges);
            free(closure_pages);
            for (pl_u32 side = 0u; side < 2u; ++side) {
                free(partition_tail_hash[side]);
                free(partition_tail_rows[side]);
                free(partition_page_rows[side]);
            }
            free(block_slots);
            free(identities);
            free(compare_second);
            free(compare_first);
            free(second);
            free(first);
            free(maps);
            free(bytes);
            return 1;
        }
        if (residual_mode) {
            free(partition_queued); partition_queued = NULL;
            free(partition_queue); partition_queue = NULL;
            free(partition_touched); partition_touched = NULL;
            free(partition_class_hits); partition_class_hits = NULL;
            free(partition_class_sizes); partition_class_sizes = NULL;
            free(partition_class_starts); partition_class_starts = NULL;
            free(partition_positions); partition_positions = NULL;
            free(partition_frontier); partition_frontier = NULL;
            free(partition_order); partition_order = NULL;
            free(partition_classes); partition_classes = NULL;
            free(partition_predecessors); partition_predecessors = NULL;
            free(partition_reverse_offsets);
            partition_reverse_offsets = NULL;
            free(partition_edges); partition_edges = NULL;
            free(partition_tail_hash[0]); partition_tail_hash[0] = NULL;
            free(partition_tail_hash[1]); partition_tail_hash[1] = NULL;
            free(partition_tail_rows[0]); partition_tail_rows[0] = NULL;
            free(partition_page_rows[0]); partition_page_rows[0] = NULL;
        }
    }
    report_phase("closure partition", &phase_started);

    projection_publisher publisher = { 0 };
    if (output_directory)
        status = projection_publisher_open(
            &publisher, output_directory);
    pl_u64 unique_wasm_bytes = 0u;
    pl_u32 maximum_unique_wasm_bytes = 0u;
    pl_u64 unique_kind_bytes[3] = { 0u, 0u, 0u };
    pl_u32 unique_kind_classes[3] = { 0u, 0u, 0u };
    pl_u64 unique_kind_work[3] = { 0u, 0u, 0u };
    pl_u32 emitted_class_count = catalog.builder.identity_count;
    pl_u32 body_slot_count = 0u;
    if (!status && slots_for(emitted_class_count, &body_slot_count))
        status = PL_ERROR_WASM_RANGE;
    body_identity *body_identities = status ? NULL : malloc(
        (size_t)emitted_class_count * sizeof *body_identities);
    body_identity *shape_identities = status ? NULL : malloc(
        (size_t)emitted_class_count * sizeof *shape_identities);
    pl_u32 *kernel_ranks = status ? NULL : malloc(
        (size_t)emitted_class_count * sizeof *kernel_ranks);
    pl_u32 *body_topologies = status ? NULL : malloc(
        (size_t)emitted_class_count * sizeof *body_topologies);
    pl_u32 *body_parameter_offsets = status ? NULL : malloc(
        (size_t)emitted_class_count * sizeof *body_parameter_offsets);
    pl_u8 *body_parameter_counts = status ? NULL : malloc(
        (size_t)emitted_class_count * sizeof *body_parameter_counts);
    pl_u32 *body_slots = status ? NULL : calloc(
        body_slot_count, sizeof *body_slots);
    pl_u32 *shape_slots = status ? NULL : calloc(
        body_slot_count, sizeof *shape_slots);
    pl_u8 *body_buffer = status ? NULL : malloc(BLOCK_BODY_CAPACITY);
    pl_u64 parameter_capacity = emitted_class_count;
    pl_u64 *parameter_values = status || !parameter_capacity ? NULL : malloc(
        (size_t)parameter_capacity * sizeof *parameter_values);
    if (!status && (!body_identities || !shape_identities || !kernel_ranks
            || !body_topologies || !body_parameter_offsets
            || !body_parameter_counts || !parameter_values
            || !body_slots || !shape_slots || !body_buffer))
        status = PL_ERROR_WASM_RANGE;
    pl_u32 body_identity_count = 0u;
    pl_u32 shape_identity_count = 0u;
    pl_u64 body_shared = 0u;
    pl_u64 shape_shared = 0u;
    pl_u64 shape_wasm_bytes = 0u;
    pl_u64 parameter_words = 0u;
    pl_u32 maximum_parameter_words = 0u;
    pl_u32 zero_parameter_rows = 0u;
    pl_u64 distinct_wasm_bytes = 0u;
    pl_u64 unique_opcode_counts[PL_OPCODE_COUNT] = { 0u };
    pl_u64 selected_parameters[255];
    pl_u32 body_failure_rank = 0xffffffffu;
    pl_u64 body_failure_rip = 0u;
    pl_u32 body_failure_kind = 0u;
    pl_u32 body_failure_operation = 0u;
    pl_u32 body_failure_semantic = 0u;
    pl_u64 body_failure_argument = 0u;
    pl_u32 body_failure_locals = 0u;
    pl_u32 body_failure_stack = 0u;
    for (pl_u32 rank = 0u; !status && rank < emitted_class_count; ++rank) {
        pl_u64 rip = catalog.builder.identities[rank].representative;
        pl_x86_instruction instruction;
        pl_x86_block block = { 0 };
        pl_wasm_block emitted;
        status = pl_x86_frontend_decode(
            &catalog.builder.frontend, rip, &instruction);
        if (!status)
            status = pl_x86_block_lower(
                &catalog.builder.frontend, rip,
                &catalog.builder.formation, &block);
        if (!status) {
            status = block.kind == PL_X86_BLOCK_DIRECT
                   ? (status ? status
                      : pl_x86_block_kernel_wasm(&block, &emitted))
                   : terminal_wasm(&instruction, &block, &emitted);
        }
        pl_u32 body_bytes = 0u;
        if (!status)
            status = pl_wasm_block_measure(&emitted, 0u, &body_bytes);
        if (!status) {
            unique_wasm_bytes += body_bytes;
            for (pl_u32 index = 0u; index < block.plan.node_count; ++index)
                if (block.plan.nodes[index].opcode < PL_OPCODE_COUNT)
                    ++unique_opcode_counts[block.plan.nodes[index].opcode];
            if (block.kind <= PL_X86_BLOCK_FAULT) {
                unique_kind_bytes[block.kind] += body_bytes;
                ++unique_kind_classes[block.kind];
                unique_kind_work[block.kind] += block.plan.node_count;
            }
            if (body_bytes > maximum_unique_wasm_bytes)
                maximum_unique_wasm_bytes = body_bytes;
        }
        pl_u32 written = 0u;
        if (!status && body_bytes > BLOCK_BODY_CAPACITY)
            status = PL_ERROR_WASM_RANGE;
        if (!status)
            status = pl_wasm_block_write(
                &emitted, 0u, body_buffer, BLOCK_BODY_CAPACITY, &written);
        if (!status && written != body_bytes)
            status = PL_ERROR_WASM;
        if (!status) {
            pl_u8 digest[PL_SHA256_BYTES];
            pl_sha256_digest(body_buffer, written, digest);
            pl_u64 hash = digest_hash(digest);
            pl_u32 slot = (pl_u32)(hash ^ (hash >> 32u))
                        & (body_slot_count - 1u);
            for (;;) {
                pl_u32 encoded = body_slots[slot];
                if (!encoded) {
                    pl_u32 fresh = body_identity_count++;
                    for (pl_u32 index = 0u; index < PL_SHA256_BYTES; ++index)
                        body_identities[fresh].digest[index] = digest[index];
                    body_identities[fresh].bytes = written;
                    body_slots[slot] = fresh + 1u;
                    kernel_ranks[rank] = fresh;
                    distinct_wasm_bytes += written;
                    pl_u8 shape_digest[PL_SHA256_BYTES];
                    pl_u32 shape_bytes = 0u;
                    pl_u32 shape_parameters = 0u;
                    status = pl_wasm_block_parameterized_measure(
                        &emitted, 0u, &shape_bytes, &shape_parameters);
                    pl_u32 shape_written = 0u;
                    pl_u32 written_parameters = 0u;
                    if (!status && shape_bytes > BLOCK_BODY_CAPACITY)
                        status = PL_ERROR_WASM_RANGE;
                    if (!status && shape_parameters > 255u)
                        status = PL_ERROR_INSTANTIATION_CAPACITY;
                    if (!status)
                        status = pl_wasm_block_parameterized_write(
                            &emitted, 0u, body_buffer,
                            BLOCK_BODY_CAPACITY, &shape_written,
                            selected_parameters, 255u,
                            &written_parameters);
                    if (!status && (shape_written != shape_bytes
                            || written_parameters != shape_parameters))
                        status = PL_ERROR_WASM;
                    if (status) break;
                    pl_sha256_digest(
                        body_buffer, shape_written, shape_digest);
                    pl_u64 shape_hash = digest_hash(shape_digest);
                    pl_u32 shape_slot =
                        (pl_u32)(shape_hash ^ (shape_hash >> 32u))
                        & (body_slot_count - 1u);
                    pl_u32 topology_rank = 0xffffffffu;
                    int topology_new = 0;
                    for (;;) {
                        pl_u32 shape_encoded = shape_slots[shape_slot];
                        if (!shape_encoded) {
                            pl_u32 shape_fresh = shape_identity_count++;
                            for (pl_u32 index = 0u;
                                 index < PL_SHA256_BYTES; ++index)
                                shape_identities[shape_fresh].digest[index] =
                                    shape_digest[index];
                            shape_identities[shape_fresh].bytes = shape_written;
                            shape_slots[shape_slot] = shape_fresh + 1u;
                            shape_wasm_bytes += shape_written;
                            topology_rank = shape_fresh;
                            topology_new = 1;
                            break;
                        }
                        pl_u32 candidate = shape_encoded - 1u;
                        if (candidate >= shape_identity_count) {
                            status = PL_ERROR_WASM;
                            break;
                        }
                        if (same_digest(
                                shape_identities[candidate].digest,
                                shape_digest)) {
                            if (shape_identities[candidate].bytes
                                    != shape_written)
                                status = PL_ERROR_WASM;
                            else {
                                ++shape_shared;
                                topology_rank = candidate;
                            }
                            break;
                        }
                        shape_slot = (shape_slot + 1u)
                                   & (body_slot_count - 1u);
                    }
                    if (!status && topology_rank == 0xffffffffu)
                        status = PL_ERROR_INSTANTIATION;
                    if (!status && output_directory && topology_new) {
                        pl_u32 published_bytes = 0u;
                        pl_u32 published_parameters = 0u;
                        status = pl_wasm_block_parameterized_write(
                            &emitted, topology_rank, body_buffer,
                            BLOCK_BODY_CAPACITY, &published_bytes,
                            selected_parameters, 255u,
                            &published_parameters);
                        if (!status && published_parameters
                                != shape_parameters)
                            status = PL_ERROR_WASM;
                        if (!status)
                            status = projection_add_body(
                                &publisher, topology_rank,
                                body_buffer, published_bytes);
                    }
                    pl_u64 needed = parameter_words + shape_parameters;
                    if (!status && (needed < parameter_words
                            || needed > (1u << 24u)))
                        status = PL_ERROR_INSTANTIATION_CAPACITY;
                    if (!status && needed > parameter_capacity) {
                        pl_u64 grown = parameter_capacity;
                        while (grown < needed && grown <= (1u << 23u))
                            grown *= 2u;
                        if (grown < needed || grown > (1u << 24u))
                            status = PL_ERROR_INSTANTIATION_CAPACITY;
                        else {
                            pl_u64 *resized = realloc(
                                parameter_values,
                                (size_t)grown * sizeof *parameter_values);
                            if (!resized)
                                status = PL_ERROR_INSTANTIATION_CAPACITY;
                            else {
                                parameter_values = resized;
                                parameter_capacity = grown;
                            }
                        }
                    }
                    if (!status) {
                        body_topologies[fresh] = topology_rank;
                        body_parameter_offsets[fresh] =
                            (pl_u32)parameter_words;
                        body_parameter_counts[fresh] =
                            (pl_u8)shape_parameters;
                        for (pl_u32 index = 0u;
                             index < shape_parameters; ++index)
                            parameter_values[parameter_words + index] =
                                selected_parameters[index];
                        parameter_words = needed;
                    }
                    if (shape_parameters > maximum_parameter_words)
                        maximum_parameter_words = shape_parameters;
                    zero_parameter_rows += shape_parameters == 0u;
                    break;
                }
                pl_u32 candidate = encoded - 1u;
                if (candidate >= body_identity_count) {
                    status = PL_ERROR_WASM;
                    break;
                }
                if (same_digest(
                        body_identities[candidate].digest, digest)) {
                    if (body_identities[candidate].bytes != written)
                        status = PL_ERROR_WASM;
                    else {
                        ++body_shared;
                        kernel_ranks[rank] = candidate;
                    }
                    break;
                }
                slot = (slot + 1u) & (body_slot_count - 1u);
            }
        }
        if (status) {
            body_failure_rank = rank;
            body_failure_rip = rip;
            body_failure_kind = block.kind;
            body_failure_operation = block.machine_operation;
            body_failure_semantic = instruction.operation;
            body_failure_argument = block.machine_argument;
            body_failure_locals = block.plan.local_count;
            body_failure_stack = block.plan.stack_count;
        }
    }
    if (status && body_failure_rank != 0xffffffffu)
        fprintf(stderr,
                "cannot emit body rank=%u rip=0x%016llx kind=%u "
                "semantic=%u machine=%u argument=0x%016llx "
                "locals=%u stack=%u status=%d\n",
                body_failure_rank,
                (unsigned long long)body_failure_rip,
                body_failure_kind, body_failure_semantic,
                body_failure_operation,
                (unsigned long long)body_failure_argument,
                body_failure_locals, body_failure_stack, status);
    report_phase("topology factorization", &phase_started);
    pl_index_ref module_root = { 0 };
    if (!status && output_directory)
        status = projection_finish_modules(&publisher, &module_root);
    if (!status && output_directory) {
        pl_u8 root_bytes[PL_INDEX_REF_BYTES];
        status = pl_index_ref_write(&module_root, root_bytes);
        if (!status)
            status = publish_named(
                &publisher, "modules.index", root_bytes,
                sizeof root_bytes);
    }
    report_phase("topology publication", &phase_started);
    pl_u32 instantiation_pages = 0u;
    pl_u32 parameter_pages = 0u;
    pl_u64 instantiation_delivery_bytes = 0u;
    pl_u8 instantiation_identity[PL_SHA256_BYTES] = { 0u };
    pl_instantiation_table instantiation_table = {
        .topologies = body_topologies,
        .parameter_offsets = body_parameter_offsets,
        .parameter_counts = body_parameter_counts,
        .parameters = parameter_values,
        .instantiation_count = body_identity_count,
        .topology_count = shape_identity_count,
        .parameter_word_count = (pl_u32)parameter_words,
    };
    pl_instantiation_page_writer instantiation_writer;
    if (!status)
        status = pl_instantiation_page_writer_open(
            &instantiation_writer, &instantiation_table);
    pl_u8 *projection_page = status ? NULL : malloc(
        PL_INSTANTIATION_PAGE_BYTES);
    if (!status && !projection_page)
        status = PL_ERROR_INSTANTIATION_CAPACITY;
    pl_sha256 instantiation_hash;
    if (!status) {
        pl_sha256_open(&instantiation_hash);
        instantiation_pages = body_identity_count
            / PL_INSTANTIATION_PAGE_ROWS
            + (body_identity_count % PL_INSTANTIATION_PAGE_ROWS != 0u);
        parameter_pages = (pl_u32)parameter_words / PL_PARAMETER_PAGE_WORDS
            + ((pl_u32)parameter_words % PL_PARAMETER_PAGE_WORDS != 0u);
    }
    for (pl_u32 page = 0u; !status && page < instantiation_pages; ++page) {
        status = pl_instantiation_page_writer_write(
            &instantiation_writer, page, projection_page);
        pl_u32 first_rank = page * PL_INSTANTIATION_PAGE_ROWS;
        if (!status)
            status = pl_instantiation_page_open(
                projection_page, page, body_identity_count,
                shape_identity_count, (pl_u32)parameter_words,
                body_parameter_offsets[first_rank]);
        if (!status) {
            pl_u8 digest[PL_SHA256_BYTES];
            pl_sha256_digest(
                projection_page, PL_INSTANTIATION_PAGE_USED, digest);
            pl_sha256_write(&instantiation_hash, digest, sizeof digest);
            instantiation_delivery_bytes += PL_INSTANTIATION_PAGE_USED;
            if (output_directory)
                status = projection_add_resource(
                    &publisher, pl_executable_instantiation_key(page),
                    PL_EXECUTABLE_RESOURCE_INSTANTIATION_PAGE,
                    body_parameter_offsets[first_rank], projection_page,
                    PL_INSTANTIATION_PAGE_USED);
        }
    }
    for (pl_u32 page = 0u; !status && page < parameter_pages; ++page) {
        status = pl_parameter_page_writer_write(
            &instantiation_writer, page, projection_page);
        if (!status)
            status = pl_parameter_page_open(
                projection_page, page, (pl_u32)parameter_words);
        if (!status) {
            pl_u32 first_rank = page * PL_PARAMETER_PAGE_WORDS;
            pl_u32 count = (pl_u32)parameter_words - first_rank;
            if (count > PL_PARAMETER_PAGE_WORDS)
                count = PL_PARAMETER_PAGE_WORDS;
            pl_u32 used = PL_PARAMETER_PAGE_HEADER + count * 8u;
            pl_u8 digest[PL_SHA256_BYTES];
            pl_sha256_digest(projection_page, used, digest);
            pl_sha256_write(&instantiation_hash, digest, sizeof digest);
            instantiation_delivery_bytes += used;
            if (output_directory)
                status = projection_add_resource(
                    &publisher, pl_executable_parameter_key(page),
                    PL_EXECUTABLE_RESOURCE_PARAMETER_PAGE, 0u,
                    projection_page, used);
        }
    }
    if (!status)
        pl_sha256_close(&instantiation_hash, instantiation_identity);
    report_phase("identity publication", &phase_started);
    free(projection_page);
    if (status) {
        fprintf(stderr, "cannot measure unique block functions: %d\n",
                status);
        projection_publisher_close(&publisher);
        free(body_buffer);
        free(shape_slots);
        free(body_slots);
        free(parameter_values);
        free(body_parameter_counts);
        free(body_parameter_offsets);
        free(body_topologies);
        free(kernel_ranks);
        free(shape_identities);
        free(body_identities);
        free(partition_queued);
        free(partition_queue);
        free(partition_touched);
        free(partition_class_hits);
        free(partition_class_sizes);
        free(partition_class_starts);
        free(partition_positions);
        free(partition_frontier);
        free(partition_order);
        free(partition_classes);
        free(partition_predecessors);
        free(partition_reverse_offsets);
        free(partition_representatives);
        free(partition_edges);
        free(closure_pages);
        for (pl_u32 side = 0u; side < 2u; ++side) {
            free(partition_tail_hash[side]);
            free(partition_tail_rows[side]);
            free(partition_page_rows[side]);
        }
        free(block_slots);
        free(identities);
        free(compare_second);
        free(compare_first);
        free(second);
        free(first);
        free(maps);
        free(bytes);
        return 1;
    }
    free(parameter_values); parameter_values = NULL;
    free(body_parameter_counts); body_parameter_counts = NULL;
    free(body_parameter_offsets); body_parameter_offsets = NULL;
    free(body_topologies); body_topologies = NULL;
    residual_metrics residual = { 0 };
    if (residual_mode)
        status = measure_residual_graph(
            &catalog, partition_representatives, partition.classes,
            closure_pages, entry_map.page_count, &entry_map,
            kernel_ranks, emitted_class_count, body_identity_count, &residual,
            output_directory ? &publisher : NULL);
    report_phase("residual publication", &phase_started);
    pl_index_ref resource_root = { 0 };
    if (!status && output_directory) {
        pl_entry_map_page_writer entry_writer;
        status = pl_entry_map_page_writer_open(&entry_writer, &entry_map);
        pl_u8 *entry_page = status ? NULL : malloc(
            PL_EXECUTABLE_ENTRY_TAIL_ROW_BYTES);
        if (!status && !entry_page) status = PL_ERROR_ENTRY_MAP_FULL;
        for (pl_u32 rank = 0u;
             !status && rank < entry_map.page_count; ++rank) {
            status = pl_entry_map_page_writer_write(
                &entry_writer, rank, entry_page);
            if (!status)
                status = pl_entry_map_page_open(
                    entry_page, entry_map.tail_row_count);
            if (!status)
                status = projection_add_resource(
                    &publisher, pl_executable_entry_page_key(rank),
                    PL_EXECUTABLE_RESOURCE_ENTRY_PAGE_ROWS, 0u,
                    entry_page, PL_EXECUTABLE_ENTRY_PAGE_ROWS_BYTES);
        }
        for (pl_u32 rank = 0u;
             !status && rank < entry_map.tail_row_count; ++rank) {
            status = pl_entry_map_tail_writer_write(
                &entry_writer, rank, entry_page);
            if (!status)
                status = pl_entry_map_tail_open(
                    entry_page, entry_map.function_count);
            if (!status)
                status = projection_add_resource(
                    &publisher, pl_executable_entry_tail_key(rank),
                    PL_EXECUTABLE_RESOURCE_ENTRY_TAIL_ROW, 0u,
                    entry_page, PL_EXECUTABLE_ENTRY_TAIL_ROW_BYTES);
        }
        free(entry_page);
        if (!status)
            status = projection_finish_resources(
                &publisher, &resource_root);
        report_phase("resource index", &phase_started);
        pl_index_ref binding_root = { 0 };
        if (!status)
            status = projection_finish_bindings(
                &publisher, &image, closure_pages,
                entry_map.page_count, &binding_root);
        report_phase("binding index", &phase_started);
        pl_u32 entry_residual = 0u;
        if (!status)
            status = pl_closure_lookup(
                closure_pages, entry_map.page_count,
                &entry_map, image.entry, &entry_residual);
        pl_projection projection = {
            .source_bytes = size,
            .entry_rip = image.entry,
            .entry_residual = entry_residual,
            .function_count = shape_identity_count,
            .instantiation_count = body_identity_count,
            .parameter_word_count = (pl_u32)parameter_words,
            .residual_count = residual.states,
            .residual_edge_count = residual.edges,
            .entry_page_count = entry_map.page_count,
            .entry_tail_row_count = entry_map.tail_row_count,
            .modules = module_root,
            .resources = resource_root,
            .bindings = binding_root,
        };
        if (!status)
            pl_sha256_digest(bytes, size, projection.source_digest);
        pl_u8 projection_bytes[PL_PROJECTION_HEADER_BYTES];
        if (!status)
            status = pl_projection_write(&projection, projection_bytes);
        pl_projection checked_projection;
        if (!status)
            status = pl_projection_open(
                projection_bytes, sizeof projection_bytes,
                &checked_projection);
        if (!status)
            status = projection_publisher_finish(&publisher);
        if (!status)
            status = publish_named(
                &publisher, "projection.root", projection_bytes,
                sizeof projection_bytes);
        report_phase("projection root", &phase_started);
    }
    free(body_buffer);
    free(shape_slots);
    free(body_slots);
    free(kernel_ranks);
    free(shape_identities);
    free(body_identities);
    if (status) {
        fprintf(stderr, "cannot construct residual graph: %d\n", status);
        projection_publisher_close(&publisher);
        return 1;
    }

    printf("shard             %u/%u [%llu,%llu) of %llu\n",
           shard_index, shard_count, (unsigned long long)shard_begin,
           (unsigned long long)shard_end,
           (unsigned long long)total_coordinates);
    printf("coordinates       %llu\n",
           (unsigned long long)catalog.coordinates);
    printf("direct blocks     %llu\n",
           (unsigned long long)catalog.direct_coordinates);
    printf("  static          %llu\n",
           (unsigned long long)catalog.static_blocks);
    printf("  conditional     %llu\n",
           (unsigned long long)catalog.conditional_blocks);
    printf("  dynamic         %llu\n",
           (unsigned long long)catalog.dynamic_blocks);
    printf("barrier blocks    %llu\n",
           (unsigned long long)catalog.barrier_coordinates);
    printf("fault blocks      %llu\n",
           (unsigned long long)catalog.fault_coordinates);
    printf("successors mapped %llu\n",
           (unsigned long long)catalog.successor_in_image);
    printf("successors fault  %llu\n",
           (unsigned long long)catalog.successor_outside_image);
    printf("source retired    %llu (maximum %u per block)\n",
           (unsigned long long)catalog.source_instructions,
           catalog.maximum_source_instructions);
    printf("physical work     %llu (maximum %u per block)\n",
           (unsigned long long)catalog.physical_work,
           catalog.maximum_work);
    printf("physical span     %llu (maximum %u per block)\n",
           (unsigned long long)catalog.physical_span,
           catalog.maximum_span);
    printf("lower failures    %llu\n",
           (unsigned long long)catalog.lower_failures);
    printf("wasm failures     %llu\n",
           (unsigned long long)catalog.wasm_failures);
    printf("function classes  %u mapped, %u total\n",
           mapped_function_classes, catalog.builder.identity_count);
    if (shard_count == 1u)
        printf("transfer classes  %u\n", catalog.builder.identity_count);
    if (residual_mode) {
        printf("residual classes  %u (%u splits, %u splitters)\n",
               partition.classes, partition.splits, partition.splitters);
        printf("partition work    %llu predecessor + %llu splitter"
               " + %llu frontier states (max %u)\n",
               (unsigned long long)partition.predecessor_edges,
               (unsigned long long)partition.splitter_states,
               (unsigned long long)partition.frontier_states,
               partition.maximum_frontier);
    }
    if (residual_mode) {
        printf("residual edges    %u (%u resolver)\n",
               residual.edges, residual.resolver_edges);
        printf("residual degrees  %u zero, %u one, %u two\n",
               residual.zero_degree,
               residual.states - residual.zero_degree - residual.two_degree,
               residual.two_degree);
        printf("residual raw      %llu bytes\n",
               (unsigned long long)residual.raw_bytes);
        printf("residual delivery %u state + %u edge pages, %llu bytes\n",
               residual.state_pages, residual.edge_pages,
               (unsigned long long)residual.delivery_bytes);
        printf("residual identity ");
        for (pl_u32 index = 0u; index < PL_SHA256_BYTES; ++index)
            printf("%02x", residual.delivery_identity[index]);
        printf("\n");
    }
    printf("shared blocks     %llu\n",
           (unsigned long long)catalog.builder.shared);
    printf("identity probes   %llu (maximum %u)\n",
           (unsigned long long)catalog.builder.probes,
           catalog.builder.maximum_probe);
    printf("unique wasm bodies %llu bytes (maximum %u)\n",
           (unsigned long long)unique_wasm_bytes,
           maximum_unique_wasm_bytes);
    printf("body identities   %u, %llu shared, %llu bytes\n",
           body_identity_count, (unsigned long long)body_shared,
           (unsigned long long)distinct_wasm_bytes);
    printf("SSA topologies    %u, %llu exact bodies share a topology\n",
           shape_identity_count, (unsigned long long)shape_shared);
    printf("topology bodies   %llu representative bytes\n",
           (unsigned long long)shape_wasm_bytes);
    printf("lifted parameters %llu u64 words, %llu fixed-width bytes\n",
           (unsigned long long)parameter_words,
           (unsigned long long)(parameter_words * sizeof(pl_u64)));
    printf("parameter rows    %u zero, maximum %u words\n",
           zero_parameter_rows, maximum_parameter_words);
    printf("identity delivery %u instantiation + %u parameter pages, "
           "%llu bytes\n",
           instantiation_pages, parameter_pages,
           (unsigned long long)instantiation_delivery_bytes);
    printf("identity root     ");
    for (pl_u32 index = 0u; index < PL_SHA256_BYTES; ++index)
        printf("%02x", instantiation_identity[index]);
    printf("\n");
    if (output_directory)
        printf("topology modules  %u bounded objects in %s\n",
               publisher.module_count, output_directory);
    printf("  direct classes  %u, %llu bytes, %llu work\n",
           unique_kind_classes[PL_X86_BLOCK_DIRECT],
           (unsigned long long)unique_kind_bytes[PL_X86_BLOCK_DIRECT],
           (unsigned long long)unique_kind_work[PL_X86_BLOCK_DIRECT]);
    printf("  barrier classes %u, %llu bytes, %llu work\n",
           unique_kind_classes[PL_X86_BLOCK_MACHINE_BARRIER],
           (unsigned long long)
               unique_kind_bytes[PL_X86_BLOCK_MACHINE_BARRIER],
           (unsigned long long)
               unique_kind_work[PL_X86_BLOCK_MACHINE_BARRIER]);
    printf("  fault classes   %u, %llu bytes, %llu work\n",
           unique_kind_classes[PL_X86_BLOCK_FAULT],
           (unsigned long long)unique_kind_bytes[PL_X86_BLOCK_FAULT],
           (unsigned long long)unique_kind_work[PL_X86_BLOCK_FAULT]);
    print_top_opcodes("coordinate opcodes", catalog.opcode_coordinates);
    print_top_opcodes("unique-class opcodes", unique_opcode_counts);
    if (shard_count == 1u) {
        printf("closure pages     %llu\n",
               (unsigned long long)closure.pages);
        printf("closure coordinates %llu (%llu mapped, %llu fault)\n",
               (unsigned long long)closure.coordinates,
               (unsigned long long)closure.mapped_coordinates,
               (unsigned long long)closure.fault_coordinates);
        printf("entry tail rows   %u distinct of %u\n",
               entry_map.tail_row_count,
               entry_map.page_count * PL_ENTRY_PAGE_ROWS);
        printf("entry map bytes   %llu (dense %llu)\n",
               (unsigned long long)entry_map_bytes,
               (unsigned long long)closure.coordinates
                   * sizeof(pl_u32));
    }
    for (pl_u32 index = 0u; index < catalog.example_count; ++index)
        printf("  failure[%u]      rip=0x%016llx status=%d\n", index,
               (unsigned long long)catalog.examples[index].rip,
               catalog.examples[index].status);

    pl_u64 failures = catalog.lower_failures + catalog.wasm_failures;
    free(partition_queued);
    free(partition_queue);
    free(partition_touched);
    free(partition_class_hits);
    free(partition_class_sizes);
    free(partition_class_starts);
    free(partition_positions);
    free(partition_frontier);
    free(partition_order);
    free(partition_classes);
    free(partition_predecessors);
    free(partition_reverse_offsets);
    free(partition_representatives);
    free(partition_edges);
    free(closure_pages);
    for (pl_u32 side = 0u; side < 2u; ++side) {
        free(partition_tail_hash[side]);
        free(partition_tail_rows[side]);
        free(partition_page_rows[side]);
    }
    free(block_slots);
    free(identities);
    free(compare_second);
    free(compare_first);
    free(second);
    free(first);
    free(maps);
    free(bytes);
    projection_publisher_close(&publisher);
    return failures ? 1 : 0;
}
