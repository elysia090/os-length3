#include <artifact/namespace.h>

#include <stdio.h>
#include <string.h>

#define BYTES(text) ((const pl_u8 *)(text)), ((pl_u32)(sizeof(text) - 1u))

static int project(const artifact_namespace_population *population,
                   artifact_namespace_projection *projection,
                   artifact_payload *material, pl_u8 *descriptor,
                   pl_u32 *first_path, pl_u32 *alias_path,
                   pl_u32 *alias_inode)
{
    artifact_namespace_workspace workspace = {
        material, 32u, descriptor, 512u, first_path, 8u,
        alias_path, alias_inode, 8u,
    };
    return artifact_namespace_project(population, &workspace, projection);
}

static int expect_red(const artifact_namespace_population *population)
{
    artifact_payload material[32];
    pl_u8 descriptor[512];
    pl_u32 first_path[8], alias_path[8], alias_inode[8];
    artifact_namespace_projection projection = { 0 };
    return project(population, &projection, material, descriptor,
                   first_path, alias_path, alias_inode)
        == ARTIFACT_ERROR_NAMESPACE ? 0 : ARTIFACT_ERROR_NAMESPACE;
}

int main(void)
{
    static const pl_u8 capability[] = "security.capability";
    static const pl_u8 note[] = "user.note";
    static const pl_u8 note_value[] = "x";
    static const artifact_namespace_xattr xattr[] = {
        { capability, sizeof(capability) - 1u, 0, 0u },
        { note, sizeof(note) - 1u, note_value, sizeof(note_value) - 1u },
    };
    artifact_namespace_inode inodes[] = {
        { ARTIFACT_NAMESPACE_DIRECTORY, ARTIFACT_NAMESPACE_NO_CONTENT,
          0u, 0755u, 0u, 0u, 0u, 0, 0u, 0, 0u },
        { ARTIFACT_NAMESPACE_DIRECTORY, ARTIFACT_NAMESPACE_NO_CONTENT,
          0u, 0755u, 0u, 0u, 0u, 0, 0u, 0, 0u },
        { ARTIFACT_NAMESPACE_REGULAR, ARTIFACT_NAMESPACE_PAYLOAD,
          0u, 0755u, 1000u, 1000u, 0u, 0, 0u, xattr, 2u },
        { ARTIFACT_NAMESPACE_DIRECTORY, ARTIFACT_NAMESPACE_NO_CONTENT,
          0u, 0755u, 0u, 0u, 0u, 0, 0u, 0, 0u },
        { ARTIFACT_NAMESPACE_SYMLINK, ARTIFACT_NAMESPACE_NO_CONTENT,
          0u, 0777u, 0u, 0u, 0u, BYTES("target"), 0, 0u },
    };
    artifact_namespace_path paths[] = {
        { 0, 0u, 0u },
        { BYTES("bin"), 1u },
        { BYTES("bin/tool"), 2u },
        { BYTES("lib"), 3u },
        { BYTES("lib/tool-link"), 2u },
        { BYTES("link"), 4u },
    };
    artifact_namespace_population population = {
        paths, 6u, inodes, 5u,
    };
    artifact_payload material[32];
    pl_u8 descriptor[512];
    pl_u32 first_path[8], alias_path[8], alias_inode[8];
    artifact_namespace_workspace workspace = {
        material, 32u, descriptor, 512u, first_path, 8u,
        alias_path, alias_inode, 8u,
    };
    artifact_namespace_projection projection = { 0 };
    int status = artifact_namespace_project(
        &population, &workspace, &projection);
    if (!status && (projection.paths != 6u || projection.inodes != 5u
            || projection.hardlink_aliases != 1u
            || projection.xattrs != 2u
            || projection.material_occurrences != 16u
            || projection.opened_path_bytes != 31u
            || projection.retained_name_bytes != 23u
            || projection.opened_symlink_bytes != 6u
            || projection.opened_xattr_bytes != 29u
            || projection.topology_bits != 10u
            || material[0].length != 15u
            || memcmp(material[0].bytes, "NSTP\1", 5u)
            || material[1].length != 3u
            || memcmp(material[1].bytes, "bin", 3u)
            || alias_path[0] != 4u || alias_inode[0] != 2u))
        status = ARTIFACT_ERROR_NAMESPACE;

    /* The repeated directory prefixes are opened but never retained. */
    for (pl_u32 item = 0u; !status && item < projection.material_occurrences;
            ++item) {
        if (material[item].length == sizeof("lib/tool-link") - 1u
                && !memcmp(material[item].bytes, "lib/tool-link",
                           sizeof("lib/tool-link") - 1u))
            status = ARTIFACT_ERROR_NAMESPACE;
    }

    for (pl_u32 path = 0u; !status && path < population.path_count; ++path) {
        pl_u32 reopened = 0xffffffffu;
        status = artifact_namespace_reopen_inode(
            &projection, &workspace, path, &reopened);
        if (!status && reopened != paths[path].inode)
            status = ARTIFACT_ERROR_NAMESPACE;
    }
    pl_u32 path_ordinal = 0xffffffffu, inode = 0xffffffffu;
    if (!status)
        status = artifact_namespace_lookup(
            &population, &projection, &workspace,
            BYTES("lib/tool-link"), &path_ordinal, &inode);
    if (!status && (path_ordinal != 4u || inode != 2u))
        status = ARTIFACT_ERROR_NAMESPACE;
    artifact_namespace_reopened_inode reopened_metadata = { 0 };
    if (!status)
        status = artifact_namespace_reopen_metadata(
            &projection, &workspace, 2u, &reopened_metadata);
    if (!status && (reopened_metadata.kind != ARTIFACT_NAMESPACE_REGULAR
            || reopened_metadata.content_kind != ARTIFACT_NAMESPACE_PAYLOAD
            || reopened_metadata.content_ordinal
            || reopened_metadata.mode != 0755u
            || reopened_metadata.uid != 1000u
            || reopened_metadata.gid != 1000u
            || reopened_metadata.xattr_count != 2u))
        status = ARTIFACT_ERROR_NAMESPACE;
    pl_u32 content_counts[4] = { 9u, 9u, 9u, 9u };
    if (!status)
        status = artifact_namespace_reopen_content_counts(
            &projection, &workspace, content_counts);
    if (!status && (content_counts[ARTIFACT_NAMESPACE_NO_CONTENT] != 0u
            || content_counts[ARTIFACT_NAMESPACE_PAYLOAD] != 1u
            || content_counts[ARTIFACT_NAMESPACE_ELF] != 0u
            || content_counts[ARTIFACT_NAMESPACE_ARCHIVE] != 0u))
        status = ARTIFACT_ERROR_NAMESPACE;
    artifact_namespace_xattr reopened_xattr = { 0 };
    if (!status)
        status = artifact_namespace_reopen_xattr(
            &projection, &workspace, 2u, 0u, &reopened_xattr);
    if (!status && (reopened_xattr.name_bytes != sizeof(capability) - 1u
            || memcmp(reopened_xattr.name, capability,
                      sizeof(capability) - 1u)
            || reopened_xattr.value_bytes))
        status = ARTIFACT_ERROR_NAMESPACE;
    if (!status)
        status = artifact_namespace_reopen_lookup(
            &projection, &workspace,
            BYTES("lib/tool-link"), &path_ordinal, &inode);
    if (!status && (path_ordinal != 4u || inode != 2u))
        status = ARTIFACT_ERROR_NAMESPACE;
    static const pl_u32 expected_parent[] = { 0u, 0u, 1u, 0u, 3u, 0u };
    for (pl_u32 path = 0u; !status && path < population.path_count; ++path) {
        pl_u32 parent = 0xffffffffu;
        status = artifact_namespace_reopen_parent(
            &projection, &workspace, path, &parent);
        if (!status && parent != expected_parent[path])
            status = ARTIFACT_ERROR_NAMESPACE;
    }

    /* The source-free reader rejects alternate topology padding and malformed
     * sparse alias rows; neither can hide in a separate directory reader. */
    if (!status) {
        pl_u8 *topology = (pl_u8 *)material[0].bytes;
        topology[material[0].length - 1u] ^= 1u;
        pl_u32 parent = 0u;
        if (artifact_namespace_reopen_parent(
                &projection, &workspace, 4u, &parent)
                != ARTIFACT_ERROR_NAMESPACE)
            status = ARTIFACT_ERROR_NAMESPACE;
        topology[material[0].length - 1u] ^= 1u;
    }
    if (!status) {
        artifact_payload *alias =
            &material[projection.material_occurrences - 1u];
        pl_u8 *bytes = (pl_u8 *)alias->bytes;
        bytes[0] ^= 1u;
        pl_u32 reopened = 0u;
        if (artifact_namespace_reopen_inode(
                &projection, &workspace, 4u, &reopened)
                != ARTIFACT_ERROR_NAMESPACE)
            status = ARTIFACT_ERROR_NAMESPACE;
        bytes[0] ^= 1u;
    }

    /* Every removed column has a red witness: tree order/parent, generated
     * content ordinal, file-type bits, directory hardlinks and xattr order. */
    if (!status) {
        artifact_namespace_path changed[6];
        memcpy(changed, paths, sizeof(changed));
        changed[2].path = (const pl_u8 *)"missing/tool";
        changed[2].path_bytes = sizeof("missing/tool") - 1u;
        artifact_namespace_population red = population;
        red.path = changed;
        status = expect_red(&red);
    }
    if (!status) {
        pl_u32 saved = inodes[2].content_ordinal;
        inodes[2].content_ordinal = 1u;
        status = expect_red(&population);
        inodes[2].content_ordinal = saved;
    }
    if (!status) {
        pl_u32 saved = inodes[2].mode;
        inodes[2].mode |= 0100000u;
        status = expect_red(&population);
        inodes[2].mode = saved;
    }
    if (!status) {
        pl_u32 saved = paths[4].inode;
        paths[4].inode = 3u;
        status = expect_red(&population);
        paths[4].inode = saved;
    }
    if (!status) {
        artifact_namespace_xattr reversed[2] = { xattr[1], xattr[0] };
        const artifact_namespace_xattr *saved = inodes[2].xattr;
        inodes[2].xattr = reversed;
        status = expect_red(&population);
        inodes[2].xattr = saved;
    }

    if (status) {
        fprintf(stderr, "artifact namespace normal form: RED (%d)\n", status);
        return 1;
    }
    printf("artifact namespace normal form: green "
           "(31 opened path bytes -> 23 basename bytes + 10 topology bits; "
           "one sparse hardlink)\n");
    return 0;
}
