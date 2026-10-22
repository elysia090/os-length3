#define _FILE_OFFSET_BITS 64
#define _POSIX_C_SOURCE 200809L

#include <artifact/archive.h>
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
#include <unistd.h>

enum { PAGE_BYTES = 4096, CLASS_COUNT = 4 };

enum payload_class {
    CLASS_ELF,
    CLASS_ARCHIVE,
    CLASS_COMPRESSED,
    CLASS_OTHER,
};

typedef struct {
    pl_u8 digest[PL_SHA256_BYTES];
    pl_u32 extent;
    char *path;
    uint64_t offset;
    unsigned used;
} page_slot;

typedef struct {
    page_slot *slots;
    size_t capacity;
    size_t count;
} page_set;

typedef struct {
    uint64_t device;
    uint64_t inode;
    unsigned used;
} inode_slot;

typedef struct {
    inode_slot *slots;
    size_t capacity;
    size_t count;
} inode_set;

typedef struct {
    uint64_t paths;
    uint64_t inodes;
    uint64_t inode_bytes;
    uint64_t page_reads;
    uint64_t page_input_bytes;
    uint64_t zero_pages;
    uint64_t zero_bytes;
    uint64_t unique_pages;
    uint64_t unique_bytes;
    uint64_t duplicate_pages;
    uint64_t duplicate_bytes;
    uint64_t class_inodes[CLASS_COUNT];
    uint64_t class_bytes[CLASS_COUNT];
    uint64_t class_zero_pages[CLASS_COUNT];
    uint64_t class_zero_bytes[CLASS_COUNT];
    uint64_t class_unique_pages[CLASS_COUNT];
    uint64_t class_unique_bytes[CLASS_COUNT];
    uint64_t elf_load_executable_bytes;
    uint64_t elf_load_readonly_bytes;
    uint64_t elf_load_writable_bytes;
    uint64_t elf_nonload_bytes;
    uint64_t archive_members;
    uint64_t archive_symbols;
    uint64_t archive_member_payload_bytes;
    uint64_t archive_unique_member_payloads;
    uint64_t archive_unique_member_payload_bytes;
    uint64_t archive_duplicate_member_payload_bytes;
    uint64_t archive_input_bytes;
    uint64_t archive_generated_bytes;
    uint64_t archive_rewritten_streams;
    uint64_t archive_rewritten_input_bytes;
    page_set pages;
    page_set class_pages[CLASS_COUNT];
    page_set archive_member_payloads;
    inode_set seen_inodes;
} measurement;

typedef struct {
    uint64_t first;
    uint64_t last;
    pl_u32 flags;
} load_interval;

static pl_u16 read_u16(const pl_u8 *bytes)
{
    return (pl_u16)((pl_u16)bytes[0] | (pl_u16)bytes[1] << 8u);
}

static pl_u32 read_u32(const pl_u8 *bytes)
{
    return (pl_u32)bytes[0] | (pl_u32)bytes[1] << 8u
         | (pl_u32)bytes[2] << 16u | (pl_u32)bytes[3] << 24u;
}

static uint64_t read_u64(const pl_u8 *bytes)
{
    return (uint64_t)read_u32(bytes)
         | (uint64_t)read_u32(bytes + 4u) << 32u;
}

static int compare_u64(const void *left, const void *right)
{
    uint64_t a = *(const uint64_t *)left;
    uint64_t b = *(const uint64_t *)right;
    return a < b ? -1 : a > b;
}

static int measure_elf_loads(int descriptor, uint64_t file_bytes,
                             measurement *result)
{
    enum { ELF_HEADER_BYTES = 64, PROGRAM_HEADER_BYTES = 56, PT_LOAD = 1 };
    enum { PF_X = 1, PF_W = 2 };
    pl_u8 header[ELF_HEADER_BYTES];
    if (pread(descriptor, header, sizeof(header), 0) != (ssize_t)sizeof(header))
        return -1;
    if (header[4] != 2u || header[5] != 1u) return -1;
    uint64_t table = read_u64(header + 32u);
    pl_u16 row_bytes = read_u16(header + 54u);
    pl_u16 row_count = read_u16(header + 56u);
    /* ET_REL startup objects and compiler runtime objects are ELF payloads but
     * have no program-header projection.  Their complete spelling is therefore
     * non-LOAD input until the archive/object finite functions are selected. */
    if (!row_count) {
        result->elf_nonload_bytes += file_bytes;
        return 0;
    }
    if (row_bytes < PROGRAM_HEADER_BYTES || row_count > 4096u
            || table > file_bytes
            || (uint64_t)row_count * row_bytes > file_bytes - table)
        return -1;
    load_interval *loads = calloc(row_count ? row_count : 1u, sizeof(*loads));
    uint64_t *points = calloc((size_t)row_count * 2u + 2u, sizeof(*points));
    if (!loads || !points) {
        free(loads);
        free(points);
        return -1;
    }
    size_t load_count = 0u, point_count = 0u;
    points[point_count++] = 0u;
    points[point_count++] = file_bytes;
    for (pl_u16 index = 0u; index < row_count; ++index) {
        pl_u8 row[PROGRAM_HEADER_BYTES];
        off_t at = (off_t)(table + (uint64_t)index * row_bytes);
        if (pread(descriptor, row, sizeof(row), at) != (ssize_t)sizeof(row)) {
            free(loads);
            free(points);
            return -1;
        }
        if (read_u32(row) != PT_LOAD) continue;
        uint64_t first = read_u64(row + 8u);
        uint64_t extent = read_u64(row + 32u);
        if (first > file_bytes || extent > file_bytes - first) {
            free(loads);
            free(points);
            return -1;
        }
        if (!extent) continue;
        loads[load_count++] = (load_interval){
            first, first + extent, read_u32(row + 4u),
        };
        points[point_count++] = first;
        points[point_count++] = first + extent;
    }
    qsort(points, point_count, sizeof(*points), compare_u64);
    for (size_t index = 0u; index + 1u < point_count; ++index) {
        uint64_t first = points[index], last = points[index + 1u];
        if (last == first) continue;
        pl_u32 flags = 0u;
        unsigned loaded = 0u;
        for (size_t load = 0u; load < load_count; ++load)
            if (loads[load].first <= first && last <= loads[load].last) {
                flags |= loads[load].flags;
                loaded = 1u;
            }
        uint64_t extent = last - first;
        if (!loaded) result->elf_nonload_bytes += extent;
        else if (flags & PF_X) result->elf_load_executable_bytes += extent;
        else if (flags & PF_W) result->elf_load_writable_bytes += extent;
        else result->elf_load_readonly_bytes += extent;
    }
    free(loads);
    free(points);
    return 0;
}

static uint64_t mix64(uint64_t value)
{
    value ^= value >> 30u;
    value *= UINT64_C(0xbf58476d1ce4e5b9);
    value ^= value >> 27u;
    value *= UINT64_C(0x94d049bb133111eb);
    return value ^ (value >> 31u);
}

static uint64_t digest_hash(const pl_u8 digest[PL_SHA256_BYTES],
                            pl_u32 extent)
{
    uint64_t value = extent;
    for (unsigned index = 0u; index < PL_SHA256_BYTES; ++index)
        value = mix64(value ^ digest[index]);
    return value;
}

static int page_equal(const page_slot *slot,
                      const pl_u8 digest[PL_SHA256_BYTES], pl_u32 extent,
                      const pl_u8 *bytes)
{
    if (slot->extent != extent
            || memcmp(slot->digest, digest, PL_SHA256_BYTES) != 0)
        return 0;
    /* A digest narrows the candidate set; it never proves payload identity.
     * Reopen the retained representative and compare the complete extent so a
     * collision cannot merge two observable pages. */
    int descriptor = open(slot->path, O_RDONLY | O_CLOEXEC);
    if (descriptor < 0) return -1;
    pl_u8 *representative = malloc(extent ? extent : 1u);
    if (!representative) {
        close(descriptor);
        return -1;
    }
    pl_u32 read_bytes = 0u;
    while (read_bytes < extent) {
        ssize_t count = pread(
            descriptor, representative + read_bytes, extent - read_bytes,
            (off_t)(slot->offset + read_bytes));
        if (count <= 0) {
            free(representative);
            close(descriptor);
            return -1;
        }
        read_bytes += (pl_u32)count;
    }
    int closed = close(descriptor);
    int equal = !closed && !memcmp(representative, bytes, extent);
    free(representative);
    return closed ? -1 : equal;
}

static int page_set_grow(page_set *set)
{
    size_t next = set->capacity ? set->capacity * 2u : 1024u;
    if (next < set->capacity || next > SIZE_MAX / sizeof(*set->slots))
        return -1;
    page_slot *slots = calloc(next, sizeof(*slots));
    if (!slots) return -1;
    for (size_t index = 0u; index < set->capacity; ++index) {
        page_slot slot = set->slots[index];
        if (!slot.used) continue;
        size_t at = (size_t)digest_hash(slot.digest, slot.extent) & (next - 1u);
        while (slots[at].used) at = (at + 1u) & (next - 1u);
        slots[at] = slot;
    }
    free(set->slots);
    set->slots = slots;
    set->capacity = next;
    return 0;
}

static int page_set_insert(page_set *set,
                           const pl_u8 digest[PL_SHA256_BYTES], pl_u32 extent,
                           const char *path, uint64_t offset,
                           const pl_u8 *bytes)
{
    if (!set->capacity || (set->count + 1u) * 10u >= set->capacity * 7u)
        if (page_set_grow(set)) return -1;
    size_t at = (size_t)digest_hash(digest, extent) & (set->capacity - 1u);
    while (set->slots[at].used) {
        int equal = page_equal(&set->slots[at], digest, extent, bytes);
        if (equal < 0) return -1;
        if (equal) return 0;
        at = (at + 1u) & (set->capacity - 1u);
    }
    char *owned_path = strdup(path);
    if (!owned_path) return -1;
    memcpy(set->slots[at].digest, digest, PL_SHA256_BYTES);
    set->slots[at].extent = extent;
    set->slots[at].path = owned_path;
    set->slots[at].offset = offset;
    set->slots[at].used = 1u;
    ++set->count;
    return 1;
}

static uint64_t inode_hash(uint64_t device, uint64_t inode)
{
    return mix64(device ^ mix64(inode));
}

static int inode_set_grow(inode_set *set)
{
    size_t next = set->capacity ? set->capacity * 2u : 1024u;
    if (next < set->capacity || next > SIZE_MAX / sizeof(*set->slots))
        return -1;
    inode_slot *slots = calloc(next, sizeof(*slots));
    if (!slots) return -1;
    for (size_t index = 0u; index < set->capacity; ++index) {
        inode_slot slot = set->slots[index];
        if (!slot.used) continue;
        size_t at = (size_t)inode_hash(slot.device, slot.inode) & (next - 1u);
        while (slots[at].used) at = (at + 1u) & (next - 1u);
        slots[at] = slot;
    }
    free(set->slots);
    set->slots = slots;
    set->capacity = next;
    return 0;
}

static int inode_set_insert(inode_set *set, uint64_t device, uint64_t inode)
{
    if (!set->capacity || (set->count + 1u) * 10u >= set->capacity * 7u)
        if (inode_set_grow(set)) return -1;
    size_t at = (size_t)inode_hash(device, inode) & (set->capacity - 1u);
    while (set->slots[at].used) {
        if (set->slots[at].device == device && set->slots[at].inode == inode)
            return 0;
        at = (at + 1u) & (set->capacity - 1u);
    }
    set->slots[at] = (inode_slot){ device, inode, 1u };
    ++set->count;
    return 1;
}

static enum payload_class classify(const pl_u8 *bytes, size_t length)
{
    static const pl_u8 elf[] = { 0x7fu, 'E', 'L', 'F' };
    static const pl_u8 archive[] = { '!', '<', 'a', 'r', 'c', 'h', '>', '\n' };
    static const pl_u8 xz[] = { 0xfdu, 0x37u, 0x7au, 0x58u, 0x5au, 0x00u };
    static const pl_u8 zstd[] = { 0x28u, 0xb5u, 0x2fu, 0xfdu };
    if (length >= sizeof(elf) && !memcmp(bytes, elf, sizeof(elf)))
        return CLASS_ELF;
    if (length >= sizeof(archive) && !memcmp(bytes, archive, sizeof(archive)))
        return CLASS_ARCHIVE;
    if ((length >= 2u && bytes[0] == 0x1fu && bytes[1] == 0x8bu)
            || (length >= 3u && bytes[0] == 'B' && bytes[1] == 'Z'
                && bytes[2] == 'h')
            || (length >= sizeof(xz) && !memcmp(bytes, xz, sizeof(xz)))
            || (length >= sizeof(zstd) && !memcmp(bytes, zstd, sizeof(zstd))))
        return CLASS_COMPRESSED;
    return CLASS_OTHER;
}

static void extent_digest(const pl_u8 *bytes, pl_u32 extent,
                          pl_u8 digest[PL_SHA256_BYTES])
{
    static const pl_u8 domain[] = "artifact-canonical-extent-v1";
    pl_u8 encoded_extent[4] = {
        (pl_u8)(extent >> 24u), (pl_u8)(extent >> 16u),
        (pl_u8)(extent >> 8u), (pl_u8)extent,
    };
    pl_sha256 state;
    pl_sha256_open(&state);
    pl_sha256_write(&state, domain, sizeof(domain) - 1u);
    pl_sha256_write(&state, encoded_extent, sizeof(encoded_extent));
    if (extent) pl_sha256_write(&state, bytes, extent);
    pl_sha256_close(&state, digest);
}

static int read_extent(int descriptor, pl_u8 *target, uint64_t bytes)
{
    uint64_t at = 0u;
    while (at < bytes) {
        size_t request = bytes - at > 0x40000000u
            ? 0x40000000u : (size_t)(bytes - at);
        ssize_t count = pread(descriptor, target + at, request, (off_t)at);
        if (count <= 0) return -1;
        at += (uint64_t)count;
    }
    return 0;
}

static int measure_archive(const char *path, int descriptor,
                           uint64_t file_bytes,
                           measurement *result)
{
    if (!file_bytes || file_bytes > 0xffffffffu
            || file_bytes > (uint64_t)SIZE_MAX)
        return -1;
    pl_u8 *source = malloc((size_t)file_bytes);
    if (!source || read_extent(descriptor, source, file_bytes)) {
        free(source);
        return -1;
    }
    pl_u32 members = 0u, symbols = 0u;
    int status = artifact_archive_read_measure(
        source, (pl_u32)file_bytes, &members, &symbols);
    artifact_archive_member *member = status ? 0 : calloc(
        members, sizeof(*member));
    artifact_archive_symbol *symbol = status || !symbols ? 0 : calloc(
        symbols, sizeof(*symbol));
    pl_u32 *read_header = status ? 0 : malloc(
        (size_t)members * sizeof(*read_header));
    pl_u64 *write_header = status ? 0 : malloc(
        (size_t)members * sizeof(*write_header));
    pl_u32 *long_name = status ? 0 : malloc(
        (size_t)members * sizeof(*long_name));
    pl_u8 *generated = 0;
    if (!status && ((members && (!member || !read_header
                    || !write_header || !long_name))
            || (symbols && !symbol)))
        status = ARTIFACT_ERROR_ARCHIVE_RANGE;
    artifact_archive_read_workspace reader = {
        member, symbol, read_header, members, symbols,
    };
    artifact_archive_view view = { 0 };
    if (!status)
        status = artifact_archive_read(
            source, (pl_u32)file_bytes, &reader, &view);
    artifact_archive_workspace writer = {
        write_header, long_name, members,
    };
    artifact_archive_projection projection = { 0 };
    if (!status)
        status = artifact_archive_project(&view, &writer, &projection);
    if (!status && (projection.archive_bytes > SIZE_MAX
            || projection.archive_bytes > 0xffffffffu))
        status = ARTIFACT_ERROR_ARCHIVE_RANGE;
    pl_u32 written = 0u;
    generated = status ? 0 : malloc((size_t)projection.archive_bytes);
    if (!status && !generated) status = ARTIFACT_ERROR_ARCHIVE_RANGE;
    if (!status)
        status = artifact_archive_write(
            &view, &writer, generated,
            (pl_u32)projection.archive_bytes, &written);
    int rewritten = !status && (written != file_bytes
        || memcmp(generated, source, written < file_bytes
            ? (size_t)written : (size_t)file_bytes));
    uint64_t payload_bytes = 0u;
    for (pl_u32 index = 0u; !status && index < members; ++index) {
        if (payload_bytes > UINT64_MAX - member[index].payload_bytes)
            status = ARTIFACT_ERROR_ARCHIVE_RANGE;
        else {
            payload_bytes += member[index].payload_bytes;
            pl_u8 digest[PL_SHA256_BYTES];
            extent_digest(member[index].payload,
                          member[index].payload_bytes, digest);
            uint64_t payload_offset =
                (uint64_t)(member[index].payload - source);
            int fresh = page_set_insert(
                &result->archive_member_payloads,
                digest, member[index].payload_bytes,
                path, payload_offset, member[index].payload);
            if (fresh < 0) {
                status = ARTIFACT_ERROR_ARCHIVE_RANGE;
            } else if (fresh) {
                ++result->archive_unique_member_payloads;
                result->archive_unique_member_payload_bytes +=
                    member[index].payload_bytes;
            } else {
                result->archive_duplicate_member_payload_bytes +=
                    member[index].payload_bytes;
            }
        }
    }
    if (!status && (result->archive_members > UINT64_MAX - members
            || result->archive_symbols > UINT64_MAX - symbols
            || result->archive_member_payload_bytes
               > UINT64_MAX - payload_bytes
            || result->archive_input_bytes > UINT64_MAX - file_bytes
            || result->archive_generated_bytes > UINT64_MAX - written
            || (rewritten && (result->archive_rewritten_streams == UINT64_MAX
                || result->archive_rewritten_input_bytes
                   > UINT64_MAX - file_bytes))))
        status = ARTIFACT_ERROR_ARCHIVE_RANGE;
    if (!status) {
        result->archive_members += members;
        result->archive_symbols += symbols;
        result->archive_member_payload_bytes += payload_bytes;
        result->archive_input_bytes += file_bytes;
        result->archive_generated_bytes += written;
        if (rewritten) {
            ++result->archive_rewritten_streams;
            result->archive_rewritten_input_bytes += file_bytes;
        }
    }
    free(generated);
    free(long_name);
    free(write_header);
    free(read_header);
    free(symbol);
    free(member);
    free(source);
    return status ? -1 : 0;
}

static int all_zero(const pl_u8 *bytes, size_t length)
{
    pl_u8 value = 0u;
    for (size_t index = 0u; index < length; ++index) value |= bytes[index];
    return value == 0u;
}

static void page_digest(const pl_u8 *bytes, pl_u32 extent,
                        pl_u8 digest[PL_SHA256_BYTES])
{
    static const pl_u8 domain[] = "artifact-immutable-page-v1";
    pl_u8 encoded_extent[4] = {
        (pl_u8)(extent >> 24u), (pl_u8)(extent >> 16u),
        (pl_u8)(extent >> 8u), (pl_u8)extent,
    };
    pl_sha256 state;
    pl_sha256_open(&state);
    pl_sha256_write(&state, domain, sizeof(domain));
    pl_sha256_write(&state, encoded_extent, sizeof(encoded_extent));
    pl_sha256_write(&state, bytes, extent);
    pl_sha256_close(&state, digest);
}

static int scan_file(const char *path, const struct stat *status,
                     measurement *result)
{
    ++result->paths;
    int fresh_inode = inode_set_insert(&result->seen_inodes,
                                       (uint64_t)status->st_dev,
                                       (uint64_t)status->st_ino);
    if (fresh_inode <= 0) return fresh_inode < 0 ? -1 : 0;
    ++result->inodes;
    result->inode_bytes += (uint64_t)status->st_size;

    int descriptor = open(path, O_RDONLY | O_CLOEXEC);
    if (descriptor < 0) return -1;
    pl_u8 bytes[PAGE_BYTES];
    ssize_t count = read(descriptor, bytes, sizeof(bytes));
    if (count < 0) {
        close(descriptor);
        return -1;
    }
    enum payload_class class_id = classify(bytes, (size_t)count);
    ++result->class_inodes[class_id];
    result->class_bytes[class_id] += (uint64_t)status->st_size;
    if (class_id == CLASS_ELF
            && measure_elf_loads(descriptor, (uint64_t)status->st_size, result)) {
        close(descriptor);
        return -1;
    }
    if (class_id == CLASS_ARCHIVE
            && measure_archive(
                path, descriptor, (uint64_t)status->st_size, result)) {
        fprintf(stderr, "noncanonical GNU archive: %s\n", path);
        close(descriptor);
        return -1;
    }

    uint64_t offset = 0u;
    for (;;) {
        if (count > 0) {
            pl_u32 extent = (pl_u32)count;
            ++result->page_reads;
            result->page_input_bytes += extent;
            if (all_zero(bytes, extent)) {
                ++result->zero_pages;
                result->zero_bytes += extent;
                ++result->class_zero_pages[class_id];
                result->class_zero_bytes[class_id] += extent;
            } else {
                pl_u8 digest[PL_SHA256_BYTES];
                page_digest(bytes, extent, digest);
                int global = page_set_insert(
                    &result->pages, digest, extent, path, offset, bytes);
                int local = page_set_insert(&result->class_pages[class_id],
                                            digest, extent, path, offset,
                                            bytes);
                if (global < 0 || local < 0) {
                    close(descriptor);
                    return -1;
                }
                if (global) {
                    ++result->unique_pages;
                    result->unique_bytes += extent;
                } else {
                    ++result->duplicate_pages;
                    result->duplicate_bytes += extent;
                }
                if (local) {
                    ++result->class_unique_pages[class_id];
                    result->class_unique_bytes[class_id] += extent;
                }
            }
        }
        offset += (uint64_t)count;
        if ((size_t)count < sizeof(bytes)) break;
        count = read(descriptor, bytes, sizeof(bytes));
        if (count < 0) {
            close(descriptor);
            return -1;
        }
    }
    if (close(descriptor)) return -1;
    return 0;
}

static int walk(const char *path, measurement *result)
{
    struct stat status;
    if (lstat(path, &status)) return -1;
    if (S_ISREG(status.st_mode)) return scan_file(path, &status, result);
    if (!S_ISDIR(status.st_mode)) return 0;

    DIR *directory = opendir(path);
    if (!directory) return -1;
    int failed = 0;
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(directory);
        if (!entry) {
            if (errno) failed = -1;
            break;
        }
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, ".."))
            continue;
        size_t parent = strlen(path), name = strlen(entry->d_name);
        if (parent > SIZE_MAX - name - 2u) {
            failed = -1;
            break;
        }
        char *child = malloc(parent + name + 2u);
        if (!child) {
            failed = -1;
            break;
        }
        memcpy(child, path, parent);
        child[parent] = '/';
        memcpy(child + parent + 1u, entry->d_name, name + 1u);
        if (walk(child, result)) failed = -1;
        free(child);
        if (failed) break;
    }
    if (closedir(directory)) failed = -1;
    return failed;
}

static void release(measurement *result)
{
    for (size_t index = 0u; index < result->pages.capacity; ++index)
        if (result->pages.slots[index].used)
            free(result->pages.slots[index].path);
    free(result->pages.slots);
    for (size_t index = 0u;
            index < result->archive_member_payloads.capacity; ++index)
        if (result->archive_member_payloads.slots[index].used)
            free(result->archive_member_payloads.slots[index].path);
    free(result->archive_member_payloads.slots);
    free(result->seen_inodes.slots);
    for (unsigned class_id = 0u; class_id < CLASS_COUNT; ++class_id) {
        for (size_t index = 0u;
                index < result->class_pages[class_id].capacity; ++index)
            if (result->class_pages[class_id].slots[index].used)
                free(result->class_pages[class_id].slots[index].path);
        free(result->class_pages[class_id].slots);
    }
}

static int write_report(FILE *output, const measurement *result)
{
    static const char *const names[CLASS_COUNT] = {
        "elf", "archive", "compressed", "other",
    };
    if (fprintf(output,
            "format=artifact-immutable-page-population-v4\n"
            "identity=extent-and-exact-bytes\n"
            "digest_role=candidate-index-only\n"
            "page_bytes=%u\n"
            "regular_paths=%llu\n"
            "regular_inodes=%llu\n"
            "inode_file_bytes=%llu\n"
            "page_reads=%llu\n"
            "page_input_bytes=%llu\n"
            "zero_pages=%llu\n"
            "zero_bytes=%llu\n"
            "duplicate_nonzero_pages=%llu\n"
            "duplicate_nonzero_bytes=%llu\n"
            "unique_nonzero_pages=%llu\n"
            "page_quotient_payload_upper_bound_bytes=%llu\n",
            PAGE_BYTES,
            (unsigned long long)result->paths,
            (unsigned long long)result->inodes,
            (unsigned long long)result->inode_bytes,
            (unsigned long long)result->page_reads,
            (unsigned long long)result->page_input_bytes,
            (unsigned long long)result->zero_pages,
            (unsigned long long)result->zero_bytes,
            (unsigned long long)result->duplicate_pages,
            (unsigned long long)result->duplicate_bytes,
            (unsigned long long)result->unique_pages,
            (unsigned long long)result->unique_bytes) < 0)
        return -1;
    for (unsigned index = 0u; index < CLASS_COUNT; ++index)
        if (fprintf(output,
                "class.%s.inodes=%llu\n"
                "class.%s.input_bytes=%llu\n"
                "class.%s.zero_pages=%llu\n"
                "class.%s.zero_bytes=%llu\n"
                "class.%s.unique_nonzero_pages=%llu\n"
                "class.%s.page_quotient_payload_bytes=%llu\n",
                names[index], (unsigned long long)result->class_inodes[index],
                names[index], (unsigned long long)result->class_bytes[index],
                names[index], (unsigned long long)result->class_zero_pages[index],
                names[index], (unsigned long long)result->class_zero_bytes[index],
                names[index], (unsigned long long)result->class_unique_pages[index],
                names[index], (unsigned long long)result->class_unique_bytes[index]) < 0)
            return -1;
    if (fprintf(output,
            "elf.load_executable_bytes=%llu\n"
            "elf.load_readonly_bytes=%llu\n"
            "elf.load_writable_bytes=%llu\n"
            "elf.nonload_bytes=%llu\n"
            "elf.accounted_bytes=%llu\n",
            (unsigned long long)result->elf_load_executable_bytes,
            (unsigned long long)result->elf_load_readonly_bytes,
            (unsigned long long)result->elf_load_writable_bytes,
            (unsigned long long)result->elf_nonload_bytes,
            (unsigned long long)(result->elf_load_executable_bytes
                + result->elf_load_readonly_bytes
                + result->elf_load_writable_bytes
                + result->elf_nonload_bytes)) < 0)
        return -1;
    if (fprintf(output,
            "archive.identity=canonical-gnu-ar-view-v1\n"
            "archive.member_occurrences=%llu\n"
            "archive.symbol_occurrences=%llu\n"
            "archive.member_payload_bytes=%llu\n"
            "archive.unique_member_payloads=%llu\n"
            "archive.unique_member_payload_bytes=%llu\n"
            "archive.duplicate_member_payload_bytes=%llu\n"
            "archive.input_stream_bytes=%llu\n"
            "archive.generated_stream_bytes=%llu\n",
            (unsigned long long)result->archive_members,
            (unsigned long long)result->archive_symbols,
            (unsigned long long)result->archive_member_payload_bytes,
            (unsigned long long)result->archive_unique_member_payloads,
            (unsigned long long)result->archive_unique_member_payload_bytes,
            (unsigned long long)result->archive_duplicate_member_payload_bytes,
            (unsigned long long)result->archive_input_bytes,
            (unsigned long long)result->archive_generated_bytes) < 0)
        return -1;
    if (fprintf(output,
            "archive.rewritten_streams=%llu\n"
            "archive.rewritten_input_bytes=%llu\n",
            (unsigned long long)result->archive_rewritten_streams,
            (unsigned long long)result->archive_rewritten_input_bytes) < 0)
        return -1;
    return ferror(output) ? -1 : 0;
}

int main(int argc, char **argv)
{
    if (argc != 3) {
        fprintf(stderr, "usage: %s ROOT REPORT\n", argv[0]);
        return 2;
    }
    measurement result = { 0 };
    if (walk(argv[1], &result)) {
        fprintf(stderr, "cannot measure artifact input %s: %s\n",
                argv[1], strerror(errno));
        release(&result);
        return 1;
    }
    FILE *output = fopen(argv[2], "wb");
    if (!output || write_report(output, &result) || fclose(output)) {
        fprintf(stderr, "cannot write artifact population %s\n", argv[2]);
        if (output) fclose(output);
        release(&result);
        return 1;
    }
    release(&result);
    return 0;
}
