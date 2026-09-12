#include <artifact/resource.h>

int artifact_resource_validate(const artifact_resource *resource)
{
    return resource && resource->object.kind != ARTIFACT_RESOURCE_NONE
        && artifact_object_validate(&resource->object);
}
