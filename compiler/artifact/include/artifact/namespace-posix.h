/* Build-side POSIX adapter for the canonical release namespace. */

#ifndef ARTIFACT_NAMESPACE_POSIX_H
#define ARTIFACT_NAMESPACE_POSIX_H

#include <artifact/namespace.h>

typedef struct {
    artifact_namespace_workspace workspace;
    artifact_namespace_projection projection;
    void *owner;
} artifact_namespace_posix;

int artifact_namespace_posix_open(
    const char *root, artifact_namespace_posix *out);
void artifact_namespace_posix_close(artifact_namespace_posix *value);

#endif /* ARTIFACT_NAMESPACE_POSIX_H */
