#include <artifact/archive.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int contains_twice(const pl_u8 *bytes, pl_u32 count,
                          const pl_u8 *needle, pl_u32 needle_bytes)
{
    pl_u32 found = 0u;
    for (pl_u32 at = 0u; at + needle_bytes <= count; ++at) {
        pl_u32 equal = 1u;
        for (pl_u32 index = 0u; index < needle_bytes; ++index)
            equal &= bytes[at + index] == needle[index];
        found += equal;
    }
    return found == 2u;
}

int main(int argc, char **argv)
{
    static const pl_u8 payload[] = { 0x7fu, 'E', 'L', 'F', 1u, 2u, 3u };
    static const pl_u8 other_payload[] = { 9u, 8u, 7u };
    static const pl_u8 short_name[] = "a.o";
    static const pl_u8 long_name[] = "same-meaning-at-another-name.o";
    static const pl_u8 symbol_a[] = "member_a";
    static const pl_u8 symbol_b[] = "member_b";
    artifact_archive_member members[] = {
        { short_name, sizeof(short_name) - 1u, 0644u,
          payload, sizeof(payload) },
        { long_name, sizeof(long_name) - 1u, 0644u,
          payload, sizeof(payload) },
    };
    static const artifact_archive_symbol symbols[] = {
        { symbol_a, sizeof(symbol_a) - 1u, 0u },
        { symbol_b, sizeof(symbol_b) - 1u, 1u },
    };
    artifact_archive_view view = { members, 2u, symbols, 2u };
    pl_u64 member_header[2];
    pl_u32 long_name_offset[2];
    artifact_archive_workspace workspace = {
        member_header, long_name_offset, 2u,
    };
    artifact_archive_projection projection = { 0 };
    static const artifact_payload payloads[] = {
        { payload, sizeof(payload) },
        { payload, sizeof(payload) },
        { other_payload, sizeof(other_payload) },
    };
    static const pl_u32 member_occurrence[] = { 0u, 1u };
    enum { PAYLOAD_COUNT = sizeof(payloads) / sizeof(payloads[0]) };
    pl_u32 digest_bytes = 0u, index_capacity = 0u;
    int status = artifact_share_measure(
        PAYLOAD_COUNT, &digest_bytes, &index_capacity);
    pl_u8 *digest = status ? 0 : malloc(digest_bytes);
    pl_u32 *index = status ? 0 : malloc(
        (size_t)index_capacity * 4u * sizeof(*index));
    artifact_complete_observation *observation = status ? 0 : malloc(
        (size_t)PAYLOAD_COUNT * sizeof(*observation));
    artifact_payload_workspace payload_workspace = {
        observation, PAYLOAD_COUNT,
        { digest, digest_bytes, index,
          index ? index + index_capacity : 0,
          index ? index + index_capacity * 2u : 0,
          index ? index + index_capacity * 3u : 0,
          index_capacity },
    };
    artifact_payload_projection payload_projection = { 0 };
    if (!status && (!digest || !index || !observation))
        status = ARTIFACT_ERROR_ARCHIVE_RANGE;
    if (!status)
        status = artifact_payload_project(
            payloads, PAYLOAD_COUNT, &payload_workspace,
            &payload_projection);
    if (!status) {
        status = artifact_archive_verify_payload_ranks(
            &view, payloads, PAYLOAD_COUNT, member_occurrence,
            &payload_workspace, &payload_projection);
    }
    if (!status && (payload_projection.classes != 2u
            || payload_workspace.share.rank[0]
               != payload_workspace.share.rank[1]))
        status = ARTIFACT_ERROR_ARCHIVE;

    /* A member occurrence bound to different bytes is a red. */
    if (!status) {
        pl_u32 wrong_occurrence[] = { 0u, 2u };
        if (artifact_archive_verify_payload_ranks(
                &view, payloads, PAYLOAD_COUNT, wrong_occurrence,
                &payload_workspace, &payload_projection)
                != ARTIFACT_ERROR_ARCHIVE)
            status = ARTIFACT_ERROR_ARCHIVE;
    }
    if (!status)
        status = artifact_archive_project(&view, &workspace, &projection);
    pl_u8 *bytes = status ? 0 : malloc((size_t)projection.archive_bytes);
    pl_u32 written = 0u;
    if (!status && !bytes) status = ARTIFACT_ERROR_ARCHIVE_RANGE;
    if (!status)
        status = artifact_archive_write(
            &view, &workspace, bytes, (pl_u32)projection.archive_bytes,
            &written);
    if (!status && (written != projection.archive_bytes
            || projection.payload_occurrence_bytes != sizeof(payload) * 2u
            || !projection.generated_stream_bytes
            || !projection.long_name_bytes
            || !projection.symbol_index_bytes
            || !contains_twice(bytes, written, payload, sizeof(payload))))
        status = ARTIFACT_ERROR_ARCHIVE;

    /* The release scanner opens the same byte stream back into the sole
     * archive view. Symbol offsets use the monotone member-header column;
     * there is no symbol-by-member search or copied member payload. */
    pl_u32 measured_members = 0u, measured_symbols = 0u;
    if (!status)
        status = artifact_archive_read_measure(
            bytes, written, &measured_members, &measured_symbols);
    artifact_archive_member read_members[2];
    artifact_archive_symbol read_symbols[2];
    pl_u32 read_header[2];
    artifact_archive_read_workspace read_workspace = {
        read_members, read_symbols, read_header, 2u, 2u,
    };
    artifact_archive_view read_view = { 0 };
    if (!status)
        status = artifact_archive_read(
            bytes, written, &read_workspace, &read_view);
    if (!status && (measured_members != 2u || measured_symbols != 2u
            || read_view.member_count != 2u
            || read_view.symbol_count != 2u
            || read_view.members[0].name_bytes != sizeof(short_name) - 1u
            || memcmp(read_view.members[0].name,
                      short_name, sizeof(short_name) - 1u)
            || read_view.members[1].name_bytes != sizeof(long_name) - 1u
            || memcmp(read_view.members[1].name,
                      long_name, sizeof(long_name) - 1u)
            || read_view.members[0].payload != bytes + read_header[0] + 60u
            || read_view.members[1].payload != bytes + read_header[1] + 60u
            || read_view.symbols[0].member_rank != 0u
            || read_view.symbols[1].member_rank != 1u))
        status = ARTIFACT_ERROR_ARCHIVE;

    pl_u8 *reopened = status ? 0 : malloc(written);
    artifact_archive_instance instance = {
        view, member_occurrence, bytes, written,
    };
    artifact_archive_complete_workspace complete_workspace = {
        payload_workspace, member_header, long_name_offset, 2u,
        reopened, written,
    };
    artifact_archive_complete_projection complete = { 0 };
    if (!status && !reopened) status = ARTIFACT_ERROR_ARCHIVE_RANGE;
    pl_u64 read_member_header[2];
    pl_u32 read_long_name_offset[2];
    artifact_archive_workspace read_writer = {
        read_member_header, read_long_name_offset, 2u,
    };
    pl_u32 reopened_bytes = 0u;
    if (!status)
        status = artifact_archive_write(
            &read_view, &read_writer, reopened, written, &reopened_bytes);
    if (!status && (reopened_bytes != written
            || memcmp(reopened, bytes, written)))
        status = ARTIFACT_ERROR_ARCHIVE;
    if (!status) {
        bytes[75] ^= 1u;
        if (artifact_archive_read(
                bytes, written, &read_workspace, &read_view)
                != ARTIFACT_ERROR_ARCHIVE)
            status = ARTIFACT_ERROR_ARCHIVE;
        bytes[75] ^= 1u;
    }
    if (!status)
        status = artifact_archive_complete_project(
            &instance, 1u, payloads, PAYLOAD_COUNT,
            &payload_projection,
            &complete_workspace, &complete);
    if (!status && (complete.archives != 1u || complete.members != 2u
            || complete.opened_archive_bytes != written
            || complete.generated_archive_bytes != written
            || complete.removed_archive_bytes != written))
        status = ARTIFACT_ERROR_ARCHIVE;
    if (!status) {
        bytes[written - 1u] ^= 1u;
        if (artifact_archive_complete_project(
                &instance, 1u, payloads, PAYLOAD_COUNT,
                &payload_projection,
                &complete_workspace, &complete)
                != ARTIFACT_ERROR_ARCHIVE)
            status = ARTIFACT_ERROR_ARCHIVE;
        bytes[written - 1u] ^= 1u;
    }

    /* An archive with no members is the zero element of the generated view,
     * not an exceptional second storage route. */
    static const pl_u8 empty_archive[] = {
        '!', '<', 'a', 'r', 'c', 'h', '>', '\n',
    };
    pl_u32 empty_members = 1u, empty_symbols = 1u;
    artifact_archive_view empty_view = { 0 };
    artifact_archive_read_workspace empty_reader = { 0 };
    artifact_archive_workspace empty_writer = { 0 };
    artifact_archive_projection empty_projection = { 0 };
    pl_u8 empty_encoded[sizeof(empty_archive)] = { 0 };
    pl_u32 empty_written = 0u;
    if (!status)
        status = artifact_archive_read_measure(
            empty_archive, sizeof(empty_archive),
            &empty_members, &empty_symbols);
    if (!status && (empty_members || empty_symbols))
        status = ARTIFACT_ERROR_ARCHIVE;
    if (!status)
        status = artifact_archive_read(
            empty_archive, sizeof(empty_archive),
            &empty_reader, &empty_view);
    if (!status)
        status = artifact_archive_project(
            &empty_view, &empty_writer, &empty_projection);
    if (!status)
        status = artifact_archive_write(
            &empty_view, &empty_writer,
            empty_encoded, sizeof(empty_encoded), &empty_written);
    if (!status && (empty_projection.archive_bytes != sizeof(empty_archive)
            || empty_written != sizeof(empty_archive)
            || memcmp(empty_archive, empty_encoded, sizeof(empty_archive))))
        status = ARTIFACT_ERROR_ARCHIVE;

    if (!status && argc == 2) {
        FILE *output = fopen(argv[1], "wb");
        if (!output || fwrite(bytes, 1u, written, output) != written
                || fclose(output))
            status = ARTIFACT_ERROR_ARCHIVE;
    } else if (!status && argc != 1) {
        status = ARTIFACT_ERROR_ARCHIVE_RANGE;
    }
    if (status) {
        fprintf(stderr, "artifact generated archive view: RED (%d)\n", status);
        free(bytes);
        free(reopened);
        free(observation);
        free(index);
        free(digest);
        return 1;
    }
    printf("artifact generated archive view: green "
           "(2 members -> 1 external payload rank; %llu generated bytes)\n",
           (unsigned long long)projection.generated_stream_bytes);
    free(bytes);
    free(reopened);
    free(observation);
    free(index);
    free(digest);
    return 0;
}
