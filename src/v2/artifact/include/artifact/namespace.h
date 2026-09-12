/* Canonical read-only release namespace; Linux remains the VFS authority. */

#ifndef ARTIFACT_NAMESPACE_H
#define ARTIFACT_NAMESPACE_H

#include <artifact/payload.h>

#define ARTIFACT_ERROR_NAMESPACE       (-81)
#define ARTIFACT_ERROR_NAMESPACE_RANGE (-82)

enum artifact_namespace_inode_kind {
    ARTIFACT_NAMESPACE_DIRECTORY = 1u,
    ARTIFACT_NAMESPACE_REGULAR = 2u,
    ARTIFACT_NAMESPACE_SYMLINK = 3u,
    ARTIFACT_NAMESPACE_CHARACTER = 4u,
    ARTIFACT_NAMESPACE_BLOCK = 5u,
    ARTIFACT_NAMESPACE_FIFO = 6u,
    ARTIFACT_NAMESPACE_SOCKET = 7u,
};

enum artifact_namespace_content_kind {
    ARTIFACT_NAMESPACE_NO_CONTENT = 0u,
    ARTIFACT_NAMESPACE_PAYLOAD = 1u,
    ARTIFACT_NAMESPACE_ELF = 2u,
    ARTIFACT_NAMESPACE_ARCHIVE = 3u,
};

typedef struct {
    const pl_u8 *name;
    pl_u32 name_bytes;
    const pl_u8 *value;
    pl_u32 value_bytes;
} artifact_namespace_xattr;

typedef struct {
    pl_u32 kind;
    pl_u32 content_kind;
    /* Construction ordinal. It must equal the number of preceding regular
     * inodes with the same nonempty content kind and is therefore not stored.
     * An empty regular inode uses NO_CONTENT and ordinal zero. */
    pl_u32 content_ordinal;
    pl_u32 mode;
    pl_u32 uid;
    pl_u32 gid;
    pl_u64 rdev;
    const pl_u8 *symlink;
    pl_u32 symlink_bytes;
    const artifact_namespace_xattr *xattr;
    pl_u32 xattr_count;
} artifact_namespace_inode;

typedef struct {
    /* Relative canonical path. The root is the sole empty path. */
    const pl_u8 *path;
    pl_u32 path_bytes;
    /* Construction-only source identity. First occurrences must introduce
     * inodes in order; only later hardlink aliases retain a sparse binding. */
    pl_u32 inode;
} artifact_namespace_path;

typedef struct {
    const artifact_namespace_path *path;
    pl_u32 path_count;
    const artifact_namespace_inode *inode;
    pl_u32 inode_count;
} artifact_namespace_population;

typedef struct {
    artifact_payload *material;
    pl_u32 material_capacity;
    pl_u8 *descriptor;
    pl_u32 descriptor_capacity;
    pl_u32 *first_path;
    pl_u32 first_path_capacity;
    pl_u32 *alias_path;
    pl_u32 *alias_inode;
    pl_u32 alias_capacity;
} artifact_namespace_workspace;

typedef struct {
    pl_u32 paths;
    pl_u32 inodes;
    pl_u32 hardlink_aliases;
    pl_u32 xattrs;
    pl_u32 material_occurrences;
    pl_u64 opened_path_bytes;
    pl_u64 retained_name_bytes;
    pl_u64 opened_symlink_bytes;
    pl_u64 opened_xattr_bytes;
    pl_u64 topology_bits;
    pl_u64 descriptor_bytes;
} artifact_namespace_projection;

typedef struct {
    pl_u32 kind;
    pl_u32 content_kind;
    pl_u32 content_ordinal;
    pl_u32 mode;
    pl_u32 uid;
    pl_u32 gid;
    pl_u64 rdev;
    const pl_u8 *symlink;
    pl_u32 symlink_bytes;
    pl_u32 xattr_count;
} artifact_namespace_reopened_inode;

/* Validate the complete namespace and emit only its irreducible material.
 * Paths use component-wise preorder, so only basenames and the 2P-2 bit
 * ordered-tree topology are retained. Root spelling, ordinary path->inode
 * increments, content ordinals, parents, directory listings and authenticated
 * index nodes are generated. `mode` contains only the low permission/special
 * bits; the file type is reconstructed from `kind`. */
int artifact_namespace_project(
    const artifact_namespace_population *population,
    const artifact_namespace_workspace *workspace,
    artifact_namespace_projection *out);

/* Validate the source-free canonical stream. Every retained namespace slice
 * must be one consecutive view of `descriptor[0..descriptor_bytes)`: a
 * construction path, inode table, xattr allocation or alias scratch column
 * can therefore never remain as a second byte owner. */
int artifact_namespace_validate(
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace);

/* Reopen generated coordinates from emitted material only. No construction
 * array, complete path spelling or dense path->inode/parent column is read. */
int artifact_namespace_reopen_inode(
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace,
    pl_u32 path, pl_u32 *inode);

int artifact_namespace_reopen_parent(
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace,
    pl_u32 path, pl_u32 *parent);

int artifact_namespace_reopen_lookup(
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace,
    const pl_u8 *path, pl_u32 path_bytes,
    pl_u32 *path_ordinal, pl_u32 *inode);

int artifact_namespace_reopen_metadata(
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace,
    pl_u32 inode, artifact_namespace_reopened_inode *out);

int artifact_namespace_reopen_xattr(
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace,
    pl_u32 inode, pl_u32 xattr,
    artifact_namespace_xattr *out);

/* Construction-time oracle used to compare the source population with the
 * source-free reopen functions above. */
int artifact_namespace_lookup(
    const artifact_namespace_population *population,
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace,
    const pl_u8 *path, pl_u32 path_bytes,
    pl_u32 *path_ordinal, pl_u32 *inode);

#endif /* ARTIFACT_NAMESPACE_H */
