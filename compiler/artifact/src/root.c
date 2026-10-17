#include <artifact/root.h>

int artifact_root_validate(const artifact_root *root)
{
    return root && root->version == ARTIFACT_ROOT_VERSION
        && root->generation && artifact_object_validate(&root->directory);
}
