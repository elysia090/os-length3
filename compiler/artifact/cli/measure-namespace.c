#define _FILE_OFFSET_BITS 64
#define _POSIX_C_SOURCE 200809L

#include <artifact/factor-index.h>
#include <artifact/namespace.h>
#include <artifact/namespace-posix.h>
#include <support/sha256.h>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/xattr.h>
#include <unistd.h>

typedef struct {
    char *relative;
    char *full;
    struct stat status;
} source_entry;

typedef struct {
    source_entry *entry;
    size_t count;
    size_t capacity;
} source_tree;

typedef struct {
    uint64_t device;
    uint64_t number;
    pl_u32 rank;
    unsigned used;
} inode_slot;

static uint64_t mix64(uint64_t value)
{
    value ^= value >> 30u;
    value *= UINT64_C(0xbf58476d1ce4e5b9);
    value ^= value >> 27u;
    value *= UINT64_C(0x94d049bb133111eb);
    return value ^ (value >> 31u);
}

static int narrow_u32(uintmax_t value, pl_u32 *out)
{
    if (value > UINT32_MAX) return 0;
    *out = (pl_u32)value;
    return 1;
}

static int bytes_compare(const char *left, size_t left_bytes,
                         const char *right, size_t right_bytes)
{
    size_t common = left_bytes < right_bytes ? left_bytes : right_bytes;
    int order = memcmp(left, right, common);
    return order ? order : left_bytes < right_bytes ? -1
         : left_bytes > right_bytes;
}

static int path_compare_bytes(const char *left, const char *right)
{
    size_t left_bytes = strlen(left), right_bytes = strlen(right);
    size_t left_at = 0u, right_at = 0u;
    while (left_at < left_bytes && right_at < right_bytes) {
        size_t left_end = left_at, right_end = right_at;
        while (left_end < left_bytes && left[left_end] != '/') ++left_end;
        while (right_end < right_bytes && right[right_end] != '/') ++right_end;
        int order = bytes_compare(
            left + left_at, left_end - left_at,
            right + right_at, right_end - right_at);
        if (order) return order;
        left_at = left_end < left_bytes ? left_end + 1u : left_end;
        right_at = right_end < right_bytes ? right_end + 1u : right_end;
    }
    return left_at < left_bytes ? 1 : right_at < right_bytes ? -1 : 0;
}

static int entry_compare(const void *left, const void *right)
{
    const source_entry *a = left, *b = right;
    return path_compare_bytes(a->relative, b->relative);
}

static int append_entry(source_tree *tree, const char *relative,
                        const char *full, const struct stat *status)
{
    if (tree->count == tree->capacity) {
        size_t capacity = tree->capacity ? tree->capacity * 2u : 1024u;
        if (capacity < tree->capacity
                || capacity > SIZE_MAX / sizeof(*tree->entry))
            return -1;
        source_entry *entry = realloc(
            tree->entry, capacity * sizeof(*entry));
        if (!entry) return -1;
        tree->entry = entry;
        tree->capacity = capacity;
    }
    char *owned_relative = strdup(relative);
    char *owned_full = strdup(full);
    if (!owned_relative || !owned_full) {
        free(owned_relative);
        free(owned_full);
        return -1;
    }
    tree->entry[tree->count++] = (source_entry){
        owned_relative, owned_full, *status,
    };
    return 0;
}

static int walk(source_tree *tree, const char *root,
                const char *relative)
{
    size_t root_bytes = strlen(root), relative_bytes = strlen(relative);
    if (root_bytes > SIZE_MAX - relative_bytes - 2u) return -1;
    char *full = malloc(root_bytes + relative_bytes + 2u);
    if (!full) return -1;
    memcpy(full, root, root_bytes);
    if (relative_bytes) {
        full[root_bytes] = '/';
        memcpy(full + root_bytes + 1u, relative, relative_bytes + 1u);
    } else {
        full[root_bytes] = 0;
    }
    struct stat status;
    if (lstat(full, &status)
            || append_entry(tree, relative, full, &status)) {
        free(full);
        return -1;
    }
    if (!S_ISDIR(status.st_mode)) {
        free(full);
        return 0;
    }
    DIR *directory = opendir(full);
    if (!directory) {
        free(full);
        return -1;
    }
    int failed = 0;
    for (;;) {
        errno = 0;
        struct dirent *item = readdir(directory);
        if (!item) {
            if (errno) failed = -1;
            break;
        }
        if (!strcmp(item->d_name, ".") || !strcmp(item->d_name, ".."))
            continue;
        size_t name_bytes = strlen(item->d_name);
        if (relative_bytes > SIZE_MAX - name_bytes - 2u) {
            failed = -1;
            break;
        }
        char *child = malloc(relative_bytes + name_bytes + 2u);
        if (!child) {
            failed = -1;
            break;
        }
        if (relative_bytes) {
            memcpy(child, relative, relative_bytes);
            child[relative_bytes] = '/';
            memcpy(child + relative_bytes + 1u,
                   item->d_name, name_bytes + 1u);
        } else {
            memcpy(child, item->d_name, name_bytes + 1u);
        }
        if (walk(tree, root, child)) failed = -1;
        free(child);
        if (failed) break;
    }
    if (closedir(directory)) failed = -1;
    free(full);
    return failed;
}

static int xattr_compare(const void *left, const void *right)
{
    const artifact_namespace_xattr *a = left, *b = right;
    return bytes_compare((const char *)a->name, a->name_bytes,
                         (const char *)b->name, b->name_bytes);
}

static int read_xattrs(const char *path, artifact_namespace_inode *inode)
{
    ssize_t list_bytes = llistxattr(path, 0, 0u);
    if (list_bytes < 0 && (errno == ENOTSUP || errno == EOPNOTSUPP)) return 0;
    if (list_bytes < 0 || (uint64_t)list_bytes > 0xffffffffu) return -1;
    if (!list_bytes) return 0;
    char *list = malloc((size_t)list_bytes);
    if (!list || llistxattr(path, list, (size_t)list_bytes) != list_bytes) {
        free(list);
        return -1;
    }
    pl_u32 count = 0u;
    for (ssize_t at = 0; at < list_bytes;) {
        size_t bytes = strlen(list + at);
        if (!bytes || bytes >= (size_t)(list_bytes - at)) {
            free(list);
            return -1;
        }
        ++count;
        at += (ssize_t)bytes + 1;
    }
    artifact_namespace_xattr *values = calloc(count, sizeof(*values));
    if (!values) {
        free(list);
        return -1;
    }
    pl_u32 index = 0u;
    for (ssize_t at = 0; at < list_bytes; ++index) {
        size_t name_bytes = strlen(list + at);
        char *name = strdup(list + at);
        ssize_t value_bytes = name
            ? lgetxattr(path, list + at, 0, 0u) : -1;
        pl_u8 *value = value_bytes > 0 ? malloc((size_t)value_bytes) : 0;
        if (!name || value_bytes < 0 || (uint64_t)value_bytes > 0xffffffffu
                || (value_bytes > 0 && (!value || lgetxattr(
                    path, list + at, value, (size_t)value_bytes)
                    != value_bytes))) {
            free(name);
            free(value);
            for (pl_u32 old = 0u; old < index; ++old) {
                free((void *)values[old].name);
                free((void *)values[old].value);
            }
            free(values);
            free(list);
            return -1;
        }
        values[index] = (artifact_namespace_xattr){
            (const pl_u8 *)name, (pl_u32)name_bytes,
            value, (pl_u32)value_bytes,
        };
        at += (ssize_t)name_bytes + 1;
    }
    qsort(values, count, sizeof(*values), xattr_compare);
    inode->xattr = values;
    inode->xattr_count = count;
    free(list);
    return 0;
}

static int classify_regular(const source_entry *entry,
                            pl_u32 *content_kind)
{
    if (!entry->status.st_size) {
        *content_kind = ARTIFACT_NAMESPACE_NO_CONTENT;
        return 0;
    }
    pl_u8 bytes[18] = { 0 };
    int descriptor = open(entry->full, O_RDONLY | O_CLOEXEC);
    ssize_t count = descriptor < 0 ? -1 : read(descriptor, bytes, sizeof(bytes));
    int closed = descriptor < 0 ? -1 : close(descriptor);
    if (count < 0 || closed) return -1;
    static const pl_u8 archive[] = { '!', '<', 'a', 'r', 'c', 'h', '>', '\n' };
    if (count >= 8 && !memcmp(bytes, archive, sizeof(archive)))
        *content_kind = ARTIFACT_NAMESPACE_ARCHIVE;
    else if (count >= 18 && bytes[0] == 0x7fu && bytes[1] == 'E'
            && bytes[2] == 'L' && bytes[3] == 'F' && bytes[4] == 2u
            && bytes[5] == 1u
            && (bytes[16] == 2u || bytes[16] == 3u) && bytes[17] == 0u)
        *content_kind = ARTIFACT_NAMESPACE_ELF;
    else
        *content_kind = ARTIFACT_NAMESPACE_PAYLOAD;
    return 0;
}

static int build_inode(const source_entry *entry,
                       pl_u32 content_count[4],
                       artifact_namespace_inode *inode)
{
    mode_t mode = entry->status.st_mode;
    pl_u32 uid = 0u, gid = 0u;
    if (!narrow_u32((uintmax_t)entry->status.st_uid, &uid)
            || !narrow_u32((uintmax_t)entry->status.st_gid, &gid))
        return -1;
    inode->mode = (pl_u32)(mode & 07777u);
    inode->uid = uid;
    inode->gid = gid;
    if (S_ISDIR(mode)) inode->kind = ARTIFACT_NAMESPACE_DIRECTORY;
    else if (S_ISREG(mode)) inode->kind = ARTIFACT_NAMESPACE_REGULAR;
    else if (S_ISLNK(mode)) inode->kind = ARTIFACT_NAMESPACE_SYMLINK;
    else if (S_ISCHR(mode)) inode->kind = ARTIFACT_NAMESPACE_CHARACTER;
    else if (S_ISBLK(mode)) inode->kind = ARTIFACT_NAMESPACE_BLOCK;
    else if (S_ISFIFO(mode)) inode->kind = ARTIFACT_NAMESPACE_FIFO;
    else if (S_ISSOCK(mode)) inode->kind = ARTIFACT_NAMESPACE_SOCKET;
    else return -1;
    if (inode->kind == ARTIFACT_NAMESPACE_CHARACTER
            || inode->kind == ARTIFACT_NAMESPACE_BLOCK)
        inode->rdev = (pl_u64)entry->status.st_rdev;
    if (inode->kind == ARTIFACT_NAMESPACE_REGULAR) {
        if (classify_regular(entry, &inode->content_kind)) return -1;
        if (inode->content_kind != ARTIFACT_NAMESPACE_NO_CONTENT)
            inode->content_ordinal = content_count[inode->content_kind]++;
    } else if (inode->kind == ARTIFACT_NAMESPACE_SYMLINK) {
        size_t capacity = entry->status.st_size > 0
            ? (size_t)entry->status.st_size + 1u : 256u;
        pl_u8 *target = malloc(capacity);
        if (!target) return -1;
        ssize_t bytes = readlink(entry->full, (char *)target, capacity);
        if (bytes <= 0 || (size_t)bytes == capacity
                || (uint64_t)bytes > 0xffffffffu) {
            free(target);
            return -1;
        }
        inode->symlink = target;
        inode->symlink_bytes = (pl_u32)bytes;
    }
    return read_xattrs(entry->full, inode);
}

static void close_tree(source_tree *tree)
{
    for (size_t index = 0u; index < tree->count; ++index) {
        free(tree->entry[index].full);
        free(tree->entry[index].relative);
    }
    free(tree->entry);
}

static void close_inodes(artifact_namespace_inode *inode, pl_u32 count)
{
    for (pl_u32 index = 0u; index < count; ++index) {
        free((void *)inode[index].symlink);
        for (pl_u32 xattr = 0u; xattr < inode[index].xattr_count; ++xattr) {
            free((void *)inode[index].xattr[xattr].name);
            free((void *)inode[index].xattr[xattr].value);
        }
        free((void *)inode[index].xattr);
    }
    free(inode);
}

typedef struct {
    source_tree tree;
    artifact_namespace_path *path;
    artifact_namespace_inode *inode;
    inode_slot *slot;
    artifact_payload *material;
    pl_u8 *descriptor;
    pl_u32 *first_path;
    pl_u32 *alias;
    pl_u32 inode_count;
} namespace_posix_owner;

static void discard_construction(namespace_posix_owner *owner)
{
    if (!owner) return;
    free(owner->alias);
    owner->alias = 0;
    free(owner->first_path);
    owner->first_path = 0;
    free(owner->slot);
    owner->slot = 0;
    close_inodes(owner->inode, owner->inode_count);
    owner->inode = 0;
    owner->inode_count = 0u;
    free(owner->path);
    owner->path = 0;
    close_tree(&owner->tree);
    owner->tree = (source_tree){ 0 };
}

void artifact_namespace_posix_close(artifact_namespace_posix *value)
{
    if (!value || !value->owner) return;
    namespace_posix_owner *owner = value->owner;
    free(owner->descriptor);
    free(owner->material);
    discard_construction(owner);
    free(owner);
    *value = (artifact_namespace_posix){ 0 };
}

static int namespace_posix_open(const char *root,
    artifact_namespace_posix *out, int keep_source)
{
    if (!root || !out) return ARTIFACT_ERROR_NAMESPACE_RANGE;
    *out = (artifact_namespace_posix){ 0 };
    namespace_posix_owner *owner = calloc(1u, sizeof(*owner));
    if (!owner) return ARTIFACT_ERROR_NAMESPACE_RANGE;
    out->owner = owner;
    int status = walk(&owner->tree, root, "");
    if (!status && (owner->tree.count > 0xffffffffu
            || !owner->tree.count))
        status = ARTIFACT_ERROR_NAMESPACE_RANGE;
    if (!status)
        qsort(owner->tree.entry, owner->tree.count,
              sizeof(*owner->tree.entry), entry_compare);
    pl_u32 paths = status ? 0u : (pl_u32)owner->tree.count;
    owner->path = status ? 0 : calloc(paths, sizeof(*owner->path));
    owner->inode = status ? 0 : calloc(paths, sizeof(*owner->inode));
    size_t slot_count = 1u;
    while (!status && slot_count < owner->tree.count * 2u) slot_count *= 2u;
    owner->slot = status ? 0 : calloc(slot_count, sizeof(*owner->slot));
    if (!status && (!owner->path || !owner->inode || !owner->slot))
        status = ARTIFACT_ERROR_NAMESPACE_RANGE;
    pl_u32 content_count[4] = { 0u, 0u, 0u, 0u };
    for (pl_u32 index = 0u; !status && index < paths; ++index) {
        source_entry *entry = &owner->tree.entry[index];
        uint64_t device = (uint64_t)entry->status.st_dev;
        uint64_t number = (uint64_t)entry->status.st_ino;
        size_t at = (size_t)mix64(device ^ mix64(number)) & (slot_count - 1u);
        while (owner->slot[at].used
                && (owner->slot[at].device != device
                    || owner->slot[at].number != number))
            at = (at + 1u) & (slot_count - 1u);
        pl_u32 rank = owner->slot[at].used
            ? owner->slot[at].rank : owner->inode_count;
        if (!owner->slot[at].used) {
            owner->slot[at] = (inode_slot){
                device, number, owner->inode_count, 1u,
            };
            if (build_inode(entry, content_count,
                            &owner->inode[owner->inode_count]))
                status = ARTIFACT_ERROR_NAMESPACE;
            else
                ++owner->inode_count;
        }
        size_t path_bytes = strlen(entry->relative);
        if (path_bytes > 0xffffffffu)
            status = ARTIFACT_ERROR_NAMESPACE_RANGE;
        else
            owner->path[index] = (artifact_namespace_path){
                (const pl_u8 *)entry->relative, (pl_u32)path_bytes, rank,
            };
    }
    artifact_namespace_population population = {
        owner->path, paths, owner->inode, owner->inode_count,
    };
    pl_u64 descriptor_bytes = 13u
        + (((pl_u64)paths * 2u - 2u) + 7u) / 8u
        + (pl_u64)owner->inode_count * 27u
        + (pl_u64)(paths - owner->inode_count) * 13u;
    pl_u64 material_count = (pl_u64)paths + owner->inode_count
                          + (paths - owner->inode_count);
    for (pl_u32 index = 1u; !status && index < paths; ++index) {
        const char *path = owner->tree.entry[index].relative;
        size_t path_bytes = strlen(path), basename_at = path_bytes;
        while (basename_at && path[basename_at - 1u] != '/') --basename_at;
        descriptor_bytes += path_bytes - basename_at;
    }
    for (pl_u32 index = 0u;
            !status && index < owner->inode_count; ++index) {
        if (owner->inode[index].kind == ARTIFACT_NAMESPACE_SYMLINK) {
            ++material_count;
            descriptor_bytes += owner->inode[index].symlink_bytes;
        }
        if (owner->inode[index].xattr_count) {
            descriptor_bytes += 13u;
            ++material_count;
        }
        material_count += owner->inode[index].xattr_count;
        for (pl_u32 xattr = 0u;
                xattr < owner->inode[index].xattr_count; ++xattr)
            descriptor_bytes += 13u
                + owner->inode[index].xattr[xattr].name_bytes
                + owner->inode[index].xattr[xattr].value_bytes;
    }
    if (!status && (descriptor_bytes > 0xffffffffu
            || material_count > 0xffffffffu))
        status = ARTIFACT_ERROR_NAMESPACE_RANGE;
    pl_u32 materials = status ? 0u : (pl_u32)material_count;
    owner->material = status ? 0 : calloc(
        materials, sizeof(*owner->material));
    owner->descriptor = status ? 0 : malloc((size_t)descriptor_bytes);
    owner->first_path = status ? 0 : malloc(
        (size_t)owner->inode_count * sizeof(*owner->first_path));
    owner->alias = status ? 0 : malloc(
        (size_t)paths * 2u * sizeof(*owner->alias));
    if (!status && (!owner->material || !owner->descriptor
            || !owner->first_path || !owner->alias))
        status = ARTIFACT_ERROR_NAMESPACE_RANGE;
    out->workspace = (artifact_namespace_workspace){
        owner->material, materials,
        owner->descriptor, (pl_u32)descriptor_bytes,
        owner->first_path, owner->inode_count,
        owner->alias, owner->alias ? owner->alias + paths : 0, paths,
    };
    if (!status)
        status = artifact_namespace_project(
            &population, &out->workspace, &out->projection);
    if (!status && !keep_source) {
        discard_construction(owner);
        out->workspace.first_path = 0;
        out->workspace.first_path_capacity = 0u;
        out->workspace.alias_path = 0;
        out->workspace.alias_inode = 0;
        out->workspace.alias_capacity = 0u;
    }
    if (status) artifact_namespace_posix_close(out);
    return status;
}

int artifact_namespace_posix_open(
    const char *root, artifact_namespace_posix *out)
{
    return namespace_posix_open(root, out, 0);
}

#ifndef ARTIFACT_NAMESPACE_LIBRARY
static int same_xattrs(const char *path,
                       const artifact_namespace_inode *expected)
{
    artifact_namespace_inode current = { 0 };
    if (read_xattrs(path, &current)) return 0;
    int same = current.xattr_count == expected->xattr_count;
    for (pl_u32 i = 0u; same && i < current.xattr_count; ++i) {
        const artifact_namespace_xattr *a = &current.xattr[i];
        const artifact_namespace_xattr *b = &expected->xattr[i];
        same = a->name_bytes == b->name_bytes
            && a->value_bytes == b->value_bytes
            && !memcmp(a->name, b->name, a->name_bytes)
            && (!a->value_bytes || !memcmp(a->value, b->value, a->value_bytes));
    }
    for (pl_u32 i = 0u; i < current.xattr_count; ++i) {
        free((void *)current.xattr[i].name);
        free((void *)current.xattr[i].value);
    }
    free((void *)current.xattr);
    return same;
}

static int same_source(const struct stat *a, const struct stat *b)
{
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino
        && a->st_mode == b->st_mode && a->st_uid == b->st_uid
        && a->st_gid == b->st_gid && a->st_rdev == b->st_rdev
        && a->st_size == b->st_size && a->st_nlink == b->st_nlink
        && a->st_mtim.tv_sec == b->st_mtim.tv_sec
        && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec
        && a->st_ctim.tv_sec == b->st_ctim.tv_sec
        && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
}

static void identity_extent(pl_sha256 *hash, pl_u64 value)
{
    pl_u8 bytes[8];
    for (unsigned i = 0u; i < 8u; ++i) {
        bytes[i] = (pl_u8)value;
        value >>= 8u;
    }
    pl_sha256_write(hash, bytes, sizeof(bytes));
}

/* Build-cache identity, not an Artifact size or a publication certificate.
 * Reuse the existing canonical namespace spelling; frame exact regular bytes
 * once per inode in its canonical first-path order. Physical inode numbers,
 * root location and timestamps are not identity coordinates. */
static int root_identity(const char *root)
{
    artifact_namespace_posix value = { 0 };
    int status = namespace_posix_open(root, &value, 1);
    namespace_posix_owner *owner = value.owner;
    pl_sha256 hash;
    pl_sha256_open(&hash);
    static const pl_u8 domain[] = "package-root-content-v1";
    pl_sha256_write(&hash, domain, sizeof(domain));
    identity_extent(&hash, value.projection.descriptor_bytes);
    if (!status) pl_sha256_write(&hash, value.workspace.descriptor,
                                value.projection.descriptor_bytes);
    pl_u32 next_inode = 0u;
    for (size_t i = 0u; !status && i < owner->tree.count; ++i) {
        if (owner->path[i].inode < next_inode) continue;
        if (owner->path[i].inode != next_inode++) { status = -1; break; }
        source_entry *entry = &owner->tree.entry[i];
        if (!S_ISREG(entry->status.st_mode)) continue;
        int fd = open(entry->full, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
        struct stat before, after;
        if (fd < 0 || fstat(fd, &before)
                || !same_source(&entry->status, &before)) {
            if (fd >= 0) close(fd);
            status = -1; break;
        }
        identity_extent(&hash, (pl_u64)before.st_size);
        pl_u8 buffer[65536];
        pl_u64 read_bytes = 0u;
        for (;;) {
            ssize_t n = read(fd, buffer, sizeof(buffer));
            if (n < 0 && errno == EINTR) continue;
            if (n < 0) { status = -1; break; }
            if (!n) break;
            pl_sha256_write(&hash, buffer, (pl_u64)n);
            read_bytes += (pl_u64)n;
        }
        if (fstat(fd, &after) || !same_source(&before, &after)
                || read_bytes != (pl_u64)before.st_size) status = -1;
        if (close(fd)) status = -1;
    }
    for (size_t i = 0u; !status && i < owner->tree.count; ++i) {
        struct stat after;
        if (!same_xattrs(owner->tree.entry[i].full,
                         &owner->inode[owner->path[i].inode])
                || lstat(owner->tree.entry[i].full, &after)
                || !same_source(&owner->tree.entry[i].status, &after))
            status = -1;
    }
    if (!status) {
        pl_u8 digest[PL_SHA256_BYTES];
        pl_sha256_close(&hash, digest);
        for (unsigned i = 0u; i < PL_SHA256_BYTES; ++i)
            printf("%02x", (unsigned)digest[i]);
        putchar('\n');
    } else fprintf(stderr, "package root identity failed or source changed: %s\n", root);
    artifact_namespace_posix_close(&value);
    return status ? 1 : 0;
}

int main(int argc, char **argv)
{
    if (argc == 3 && !strcmp(argv[1], "--identity"))
        return root_identity(argv[2]);
    if (argc != 3) {
        fprintf(stderr, "usage: %s ROOT REPORT | --identity ROOT\n", argv[0]);
        return 2;
    }
    artifact_namespace_posix namespace = { 0 };
    int status = artifact_namespace_posix_open(argv[1], &namespace);
    artifact_namespace_projection namespace_projection =
        namespace.projection;
    artifact_payload *material = namespace.workspace.material;

    pl_u32 digest_bytes = 0u, index_capacity = 0u;
    if (!status)
        status = artifact_share_measure(
            namespace_projection.material_occurrences,
            &digest_bytes, &index_capacity);
    pl_u8 *digest = status ? 0 : malloc(digest_bytes);
    pl_u32 *index = status ? 0 : malloc(
        (size_t)index_capacity * 4u * sizeof(*index));
    artifact_complete_observation *observation = status ? 0 : malloc(
        (size_t)namespace_projection.material_occurrences
        * sizeof(*observation));
    if (!status && (!digest || !index || !observation)) status = -1;
    artifact_payload_workspace payload_workspace = {
        observation, namespace_projection.material_occurrences,
        { digest, digest_bytes, index,
          index ? index + index_capacity : 0,
          index ? index + index_capacity * 2u : 0,
          index ? index + index_capacity * 3u : 0,
          index_capacity },
    };
    artifact_payload_projection payload_projection = { 0 };
    if (!status)
        status = artifact_payload_project(
            material, namespace_projection.material_occurrences,
            &payload_workspace, &payload_projection);
    if (!status && payload_projection.unique_bytes > 0xffffffffu) status = -1;
    pl_u64 *end = status ? 0 : malloc(
        (size_t)payload_projection.classes * sizeof(*end));
    artifact_byte_view view = { 0 };
    if (!status && !end) status = -1;
    if (!status)
        status = artifact_payload_view(
            material, namespace_projection.material_occurrences,
            &payload_workspace, &payload_projection,
            end, payload_projection.classes, &view);
    pl_u32 vectors = 0u, nodes = 0u;
    if (!status)
        status = artifact_factor_index_measure(
            (pl_u32)view.bytes, &vectors, &nodes);
    pl_u32 *vector = status ? 0 : malloc(
        (size_t)vectors * 4u * sizeof(*vector));
    pl_u64 *cost = status ? 0 : malloc((size_t)nodes * sizeof(*cost));
    if (!status && (!vector || !cost)) status = -1;
    artifact_factor_index_workspace factor_workspace = {
        .source = vector ? vector + vectors * 2u : 0,
        .length = vector ? vector + vectors * 3u : 0,
        .suffix_array = vector,
        .rank = vector ? vector + vectors : 0,
        .vector_capacity = vectors,
        .cost_tree = cost,
        .tree_capacity = nodes,
    };
    artifact_factor_projection factor = { 0 };
    if (!status)
        status = artifact_factor_index_project(
            &view, &factor_workspace, &factor);
    pl_u64 workspace_bytes = (pl_u64)vectors * 4u * sizeof(*vector)
                           + (pl_u64)nodes * sizeof(*cost);
    FILE *report = status ? 0 : fopen(argv[2], "wb");
    if (!status && (!report || fprintf(report,
            "format=artifact-namespace-population-v1\n"
            "paths=%u\n"
            "inodes=%u\n"
            "hardlink_aliases=%u\n"
            "xattrs=%u\n"
            "opened_path_bytes=%llu\n"
            "retained_basename_bytes=%llu\n"
            "topology_bits=%llu\n"
            "descriptor_bytes=%llu\n"
            "material_occurrences=%u\n"
            "material_opened_bytes=%llu\n"
            "material_unique_bytes=%llu\n"
            "material_duplicate_bytes=%llu\n"
            "factor_bits=%llu\n"
            "factor_bytes=%llu\n"
            "factor_gap_bits=%llu\n"
            "factor_workspace_bytes=%llu\n",
            namespace_projection.paths, namespace_projection.inodes,
            namespace_projection.hardlink_aliases,
            namespace_projection.xattrs,
            (unsigned long long)namespace_projection.opened_path_bytes,
            (unsigned long long)namespace_projection.retained_name_bytes,
            (unsigned long long)namespace_projection.topology_bits,
            (unsigned long long)namespace_projection.descriptor_bytes,
            namespace_projection.material_occurrences,
            (unsigned long long)payload_projection.opened_bytes,
            (unsigned long long)payload_projection.unique_bytes,
            (unsigned long long)payload_projection.duplicate_bytes_eliminated,
            (unsigned long long)factor.retained_bits,
            (unsigned long long)((factor.retained_bits + 7u) / 8u),
            (unsigned long long)factor.unresolved_bit_gap,
            (unsigned long long)workspace_bytes) < 0 || fclose(report)))
        status = -1;
    if (status)
        fprintf(stderr, "artifact namespace population: RED (%d): %s\n",
                status, strerror(errno));
    else
        printf("artifact namespace population: green "
               "(%u paths/%u inodes -> %llu basename bytes + %llu bits; "
               "%llu factor bits)\n",
               namespace_projection.paths, namespace_projection.inodes,
               (unsigned long long)namespace_projection.retained_name_bytes,
               (unsigned long long)namespace_projection.topology_bits,
               (unsigned long long)factor.retained_bits);

    free(cost);
    free(vector);
    free(end);
    free(observation);
    free(index);
    free(digest);
    artifact_namespace_posix_close(&namespace);
    return status ? 1 : 0;
}
#endif
