/* The only published coordinate of a complete immutable machine artifact. */

#ifndef ARTIFACT_ROOT_H
#define ARTIFACT_ROOT_H

#include <artifact/object.h>

#define ARTIFACT_ROOT_VERSION 1u

typedef struct {
    pl_u32 version;
    pl_u32 flags;
    pl_u64 generation;
    artifact_object directory;
} artifact_root;

int artifact_root_validate(const artifact_root *root);

#endif /* ARTIFACT_ROOT_H */
