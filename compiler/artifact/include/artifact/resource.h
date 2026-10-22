/* Typed object selected from an authenticated artifact index. */

#ifndef ARTIFACT_RESOURCE_H
#define ARTIFACT_RESOURCE_H

#include <artifact/index.h>
#include <artifact/object.h>

#define ARTIFACT_RESOURCE_BYTES 80u
#define ARTIFACT_RESOURCE_VERSION 1u

enum artifact_resource_kind {
    ARTIFACT_RESOURCE_NONE = 0,
    ARTIFACT_RESOURCE_WASM_MODULE,
    ARTIFACT_RESOURCE_MEMORY_PAGE,
    ARTIFACT_RESOURCE_DIRECTORY,
    ARTIFACT_RESOURCE_BOOT_SNAPSHOT,
    /* Complete-image entry module, not machine.source selected-cut metadata.
     * minor key is the original ELF interval start, coordinate is exclusive
     * end. The image loader owns bias/generation/source authorization. */
    ARTIFACT_RESOURCE_IMAGE_MODULE,
    ARTIFACT_RESOURCE_IMAGE_SOURCE,
};

typedef struct {
    pl_index_key key;
    artifact_object object;
    pl_u64 coordinate;
    pl_u64 generation;
} artifact_resource;

int artifact_resource_validate(const artifact_resource *resource);
/* The existing index leaf owns this one canonical little-endian row. */
int artifact_resource_read(const pl_u8 row[ARTIFACT_RESOURCE_BYTES],
                            artifact_resource *resource);
int artifact_resource_write(const artifact_resource *resource,
                             pl_u8 row[ARTIFACT_RESOURCE_BYTES]);

#endif /* ARTIFACT_RESOURCE_H */
