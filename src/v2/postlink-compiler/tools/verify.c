/* Verify one complete compiler projection without decoding x86 again. */

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <postlink/postlink.h>

#define PATH_BYTES 1024u

typedef struct {
    FILE *pack;
    pl_u8 *index_bytes;
    pl_delivery_index index;
    pl_u8 *seen;
    pl_u32 seen_count;
} object_reader;

typedef struct verify_context verify_context;
typedef int (*row_verifier)(verify_context *context, const pl_u8 *row);

struct verify_context {
    const pl_projection *projection;
    object_reader *objects;
    const pl_x86_image_reader *source;
    pl_u32 index_nodes;
    pl_u32 module_rows;
    pl_u32 resource_rows;
    pl_u32 binding_rows;
    pl_u32 next_function;
    pl_u32 resource_kinds[9];
    pl_u32 resource_next[9];
    pl_u64 module_bytes;
    pl_u64 resource_bytes;
};

static int same_digest(const pl_u8 *left, const pl_u8 *right)
{
    pl_u32 different = 0u;
    for (pl_u32 index = 0u; index < PL_SHA256_BYTES; ++index)
        different |= (pl_u32)(left[index] ^ right[index]);
    return different == 0u;
}

static int load_file(const char *path, pl_u8 **bytes, pl_u64 *length)
{
    FILE *file = fopen(path, "rb");
    if (!file || fseek(file, 0, SEEK_END)) {
        if (file) (void)fclose(file);
        return 0;
    }
    long measured = ftell(file);
    if (measured <= 0 || fseek(file, 0, SEEK_SET)) {
        (void)fclose(file);
        return 0;
    }
    pl_u8 *storage = malloc((size_t)measured);
    if (!storage || fread(storage, 1u, (size_t)measured, file)
            != (size_t)measured || fclose(file)) {
        free(storage);
        return 0;
    }
    *bytes = storage;
    *length = (pl_u64)measured;
    return 1;
}

static int named_path(char target[PATH_BYTES], const char *directory,
                      const char *name)
{
    int bytes = snprintf(target, PATH_BYTES, "%s/%s", directory, name);
    return bytes >= 0 && (size_t)bytes < PATH_BYTES;
}

static int object_reader_open(object_reader *reader, const char *directory)
{
    char index_path[PATH_BYTES], pack_path[PATH_BYTES];
    if (!reader || !named_path(index_path, directory, "objects.index")
            || !named_path(pack_path, directory, "objects.pack"))
        return PL_ERROR_DELIVERY_RANGE;
    *reader = (object_reader){ 0 };
    pl_u64 index_bytes = 0u;
    if (!load_file(index_path, &reader->index_bytes, &index_bytes))
        return PL_ERROR_DELIVERY;
    reader->pack = fopen(pack_path, "rb");
    if (!reader->pack || fseek(reader->pack, 0, SEEK_END))
        return PL_ERROR_DELIVERY;
    long pack_bytes = ftell(reader->pack);
    if (pack_bytes <= 0 || fseek(reader->pack, 0, SEEK_SET))
        return PL_ERROR_DELIVERY;
    int status = pl_delivery_index_open(
        reader->index_bytes, index_bytes, (pl_u64)pack_bytes,
        &reader->index);
    pl_u32 seen_bytes = reader->index.count / 8u
                      + (reader->index.count % 8u != 0u);
    reader->seen = status ? NULL : calloc(seen_bytes, 1u);
    return status || !reader->seen
         ? (status ? status : PL_ERROR_DELIVERY_RANGE) : 0;
}

static void object_reader_close(object_reader *reader)
{
    if (!reader) return;
    if (reader->pack) (void)fclose(reader->pack);
    free(reader->seen);
    free(reader->index_bytes);
    *reader = (object_reader){ 0 };
}

static int object_read(object_reader *reader, const pl_u8 *digest,
                       pl_u64 expected, pl_u8 **bytes, pl_u32 *length)
{
    pl_delivery_locator locator;
    pl_u32 rank = 0u;
    int status = pl_delivery_index_find_rank(
        &reader->index, digest, &rank, &locator);
    if (status || (expected && expected != locator.bytes)
            || locator.offset > (pl_u64)LONG_MAX)
        return status ? status : PL_ERROR_DELIVERY_RANGE;
    pl_u8 *storage = malloc(locator.bytes);
    if (!storage || fseek(reader->pack, (long)locator.offset, SEEK_SET)
            || fread(storage, 1u, locator.bytes, reader->pack)
               != locator.bytes)
        status = PL_ERROR_DELIVERY;
    if (!status)
        status = pl_delivery_payload_validate(
            &locator, storage, locator.bytes);
    if (status) {
        free(storage);
        return status;
    }
    pl_u8 mask = (pl_u8)(1u << (rank & 7u));
    pl_u8 *word = &reader->seen[rank >> 3u];
    if (!(*word & mask)) {
        *word |= mask;
        ++reader->seen_count;
    }
    *bytes = storage;
    *length = locator.bytes;
    return 0;
}

static int verify_index(verify_context *context, const pl_index_ref *ref,
                        pl_u32 row_bytes, row_verifier verify_row)
{
    if (!context || !ref || !verify_row
            || ref->leaf_row_bytes != row_bytes)
        return PL_ERROR_INDEX;
    pl_u8 *bytes = NULL;
    pl_u32 length = 0u;
    int status = object_read(
        context->objects, ref->digest, ref->node_bytes, &bytes, &length);
    pl_index_node node;
    if (!status) status = pl_index_node_open(ref, bytes, length, &node);
    if (!status) ++context->index_nodes;
    if (!status && node.level) {
        for (pl_u32 rank = 0u; !status && rank < node.row_count; ++rank) {
            pl_index_ref child;
            status = pl_index_ref_read(
                node.bytes + PL_INDEX_HEADER_BYTES
                    + (pl_u64)rank * node.row_bytes,
                &child);
            if (!status)
                status = verify_index(
                    context, &child, row_bytes, verify_row);
        }
    } else if (!status) {
        for (pl_u32 rank = 0u; !status && rank < node.row_count; ++rank)
            status = verify_row(
                context, node.bytes + PL_INDEX_HEADER_BYTES
                    + (pl_u64)rank * node.row_bytes);
    }
    free(bytes);
    return status;
}

static int verify_module(verify_context *context, const pl_u8 *row)
{
    pl_executable_module module;
    int status = pl_executable_module_read(row, &module);
    if (!status)
        status = pl_executable_module_validate(
            &module, context->projection->function_count);
    if (!status && module.first_function != context->next_function)
        status = PL_ERROR_EXECUTABLE_MODULE;
    pl_u8 *payload = NULL;
    pl_u32 bytes = 0u;
    if (!status)
        status = object_read(
            context->objects, module.digest,
            module.payload_bytes, &payload, &bytes);
    if (!status)
        status = pl_executable_validate_module_payload(
            &module, payload, bytes);
    if (!status) {
        context->next_function += module.function_count;
        ++context->module_rows;
        context->module_bytes += bytes;
    }
    free(payload);
    return status;
}

static int verify_resource(verify_context *context, const pl_u8 *row)
{
    pl_executable_resource resource;
    int status = pl_executable_resource_read(row, &resource);
    if (!status) status = pl_executable_resource_validate(&resource, 1u);
    if (!status && (resource.kind < 3u || resource.kind > 8u))
        status = PL_ERROR_EXECUTABLE_RESOURCE;
    pl_u64 wide_rank = resource.physical_address
                     & PL_EXECUTABLE_RESOURCE_PROJECTION_RANK_MASK;
    pl_u32 rank = (pl_u32)wide_rank;
    if (!status && (wide_rank > 0xffffffffu
            || rank != context->resource_next[resource.kind]))
        status = PL_ERROR_EXECUTABLE_RESOURCE;
    pl_u8 *payload = NULL;
    pl_u32 bytes = 0u;
    if (!status)
        status = object_read(
            context->objects, resource.digest,
            resource.object_bytes, &payload, &bytes);
    const pl_projection *root = context->projection;
    pl_u8 mapped[PL_EXECUTABLE_PAGE_BYTES] = { 0u };
    if (!status) {
        if (bytes > sizeof mapped) status = PL_ERROR_EXECUTABLE_RESOURCE;
        else memcpy(mapped, payload, bytes);
    }
    if (!status) {
        switch (resource.kind) {
        case PL_EXECUTABLE_RESOURCE_ENTRY_PAGE_ROWS:
            status = pl_entry_map_page_open(
                mapped, root->entry_tail_row_count);
            break;
        case PL_EXECUTABLE_RESOURCE_ENTRY_TAIL_ROW:
            status = pl_entry_map_tail_open(mapped, root->residual_count);
            break;
        case PL_EXECUTABLE_RESOURCE_RESIDUAL_STATE_PAGE:
            status = pl_residual_state_page_open(
                mapped, rank, root->residual_count,
                root->residual_edge_count, root->instantiation_count);
            break;
        case PL_EXECUTABLE_RESOURCE_RESIDUAL_EDGE_PAGE:
            status = pl_residual_edge_page_open(
                mapped, rank, root->residual_count,
                root->residual_edge_count);
            break;
        case PL_EXECUTABLE_RESOURCE_INSTANTIATION_PAGE:
            status = pl_instantiation_page_open(
                mapped, rank, root->instantiation_count,
                root->function_count, root->parameter_word_count,
                resource.projection_argument);
            break;
        case PL_EXECUTABLE_RESOURCE_PARAMETER_PAGE:
            status = pl_parameter_page_open(
                mapped, rank, root->parameter_word_count);
            break;
        default: status = PL_ERROR_EXECUTABLE_RESOURCE; break;
        }
    }
    if (!status) {
        ++context->resource_kinds[resource.kind];
        ++context->resource_next[resource.kind];
        ++context->resource_rows;
        context->resource_bytes += bytes;
    }
    if (status)
        fprintf(stderr, "resource kind=%u rank=%u failed: %d\n",
                resource.kind, rank, status);
    free(payload);
    return status;
}

static int verify_binding(verify_context *context, const pl_u8 *row)
{
    pl_executable_binding binding;
    int status = pl_executable_binding_read(row, &binding);
    if (!status)
        status = pl_executable_binding_validate(
            &binding, context->projection->source_bytes,
            context->projection->function_count);
    if (!status && (binding.source_offset != PL_EXECUTABLE_SOURCE_DERIVED
            || binding.dispatch_argument
               >= context->projection->entry_page_count))
        status = PL_ERROR_EXECUTABLE_BINDING;
    pl_u8 page[PL_EXECUTABLE_PAGE_BYTES];
    if (!status)
        status = pl_x86_image_materialize(
            context->source, binding.virtual_page,
            page, sizeof page);
    pl_u8 digest[PL_SHA256_BYTES];
    if (!status) pl_sha256_digest(page, sizeof page, digest);
    if (!status && !same_digest(digest, binding.digest))
        status = PL_ERROR_EXECUTABLE_BINDING;
    if (!status) ++context->binding_rows;
    return status;
}

static pl_u32 pages(pl_u32 values, pl_u32 per_page)
{
    return values / per_page + (values % per_page != 0u);
}

int main(int argc, char **argv)
{
    if (argc != 3) {
        fprintf(stderr,
                "usage: postlink-verify LINKED-X86-ELF PROJECTION-DIRECTORY\n");
        return 2;
    }
    char root_path[PATH_BYTES];
    pl_u8 *root_bytes = NULL, *source_bytes = NULL;
    pl_u64 root_length = 0u, source_length = 0u;
    if (!named_path(root_path, argv[2], "projection.root")
            || !load_file(root_path, &root_bytes, &root_length)
            || !load_file(argv[1], &source_bytes, &source_length)) {
        fprintf(stderr, "cannot read projection or source\n");
        free(source_bytes); free(root_bytes);
        return 1;
    }
    pl_projection projection;
    int status = pl_projection_open(
        root_bytes, root_length, &projection);
    pl_u8 source_digest[PL_SHA256_BYTES];
    if (!status) pl_sha256_digest(source_bytes, source_length, source_digest);
    if (!status && (source_length != projection.source_bytes
            || !same_digest(source_digest, projection.source_digest)))
        status = PL_ERROR_PROJECTION;
    pl_elf_image elf;
    if (!status) status = pl_elf_open(source_bytes, source_length, &elf);
    pl_u32 one = 0u;
    if (!status) status = pl_x86_elf_map_count(&elf, &one);
    pl_x86_map *maps = status || one > 0x7fffffffu ? NULL
                     : malloc((size_t)one * 2u * sizeof *maps);
    if (!status && !maps) status = PL_ERROR_X86_CAPACITY;
    pl_x86_image image;
    if (!status)
        status = pl_x86_image_from_elf_coordinates(
            &elf, 0u, 0u, PL_X86_ELF_VIRTUAL,
            maps, one * 2u, &image);
    if (!status && !pl_x86_image_contains(&image, image.entry))
        status = pl_x86_image_from_elf_aliases(
            &elf, 0u, 0u, 0u, maps, one * 2u, &image);
    pl_x86_image_reader source;
    if (!status) status = pl_x86_image_reader_open(&source, &image);
    if (!status && image.entry != projection.entry_rip)
        status = PL_ERROR_PROJECTION;
    object_reader objects;
    if (!status) status = object_reader_open(&objects, argv[2]);
    else objects = (object_reader){ 0 };
    verify_context context = {
        .projection = &projection, .objects = &objects, .source = &source,
    };
    if (!status)
        status = verify_index(
            &context, &projection.modules,
            PL_EXECUTABLE_MODULE_BYTES, verify_module);
    if (!status && context.next_function != projection.function_count)
        status = PL_ERROR_EXECUTABLE_MODULE;
    if (!status)
        status = verify_index(
            &context, &projection.resources,
            PL_EXECUTABLE_RESOURCE_BYTES, verify_resource);
    if (!status)
        status = verify_index(
            &context, &projection.bindings,
            PL_EXECUTABLE_BINDING_BYTES, verify_binding);
    pl_u32 expected[9] = { 0u };
    expected[PL_EXECUTABLE_RESOURCE_ENTRY_PAGE_ROWS] =
        projection.entry_page_count;
    expected[PL_EXECUTABLE_RESOURCE_ENTRY_TAIL_ROW] =
        projection.entry_tail_row_count;
    expected[PL_EXECUTABLE_RESOURCE_RESIDUAL_STATE_PAGE] = pages(
        projection.residual_count, PL_RESIDUAL_STATE_PAGE_STATES);
    expected[PL_EXECUTABLE_RESOURCE_RESIDUAL_EDGE_PAGE] = pages(
        projection.residual_edge_count, PL_RESIDUAL_EDGE_PAGE_EDGES);
    expected[PL_EXECUTABLE_RESOURCE_INSTANTIATION_PAGE] = pages(
        projection.instantiation_count, PL_INSTANTIATION_PAGE_ROWS);
    expected[PL_EXECUTABLE_RESOURCE_PARAMETER_PAGE] = pages(
        projection.parameter_word_count, PL_PARAMETER_PAGE_WORDS);
    for (pl_u32 kind = 3u; !status && kind <= 8u; ++kind)
        if (context.resource_kinds[kind] != expected[kind])
            status = PL_ERROR_EXECUTABLE_RESOURCE;
    if (!status && (context.module_rows != projection.modules.rows
            || context.resource_rows != projection.resources.rows
            || context.binding_rows != projection.bindings.rows
            || context.binding_rows != projection.entry_page_count
            || objects.seen_count != objects.index.count))
        status = PL_ERROR_PROJECTION;
    if (status) {
        fprintf(stderr, "projection verification failed: %d\n", status);
    } else {
        printf("projection verified\n");
        printf("  topology functions  %u in %u modules (%llu bytes)\n",
               projection.function_count, context.module_rows,
               (unsigned long long)context.module_bytes);
        printf("  exact identities    %u + %u parameter words\n",
               projection.instantiation_count,
               projection.parameter_word_count);
        printf("  residual graph      %u states + %u edges\n",
               projection.residual_count, projection.residual_edge_count);
        printf("  source bindings     %u pages\n", context.binding_rows);
        printf("  delivery closure    %u objects, %llu payload bytes\n",
               objects.seen_count,
               (unsigned long long)objects.index.pack_bytes);
        printf("  index nodes         %u\n", context.index_nodes);
    }
    object_reader_close(&objects);
    free(maps);
    free(source_bytes);
    free(root_bytes);
    return status ? 1 : 0;
}
