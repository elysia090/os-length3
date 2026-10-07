#include <vm/directory.h>

void vm_directory_close(vm_directory *directory)
{
    if (directory) {
        pl_u64 sequence=directory->sequence;
        *directory=(vm_directory){.sequence=sequence};
    }
}
void vm_directory_cancel(vm_directory *directory)
{
    if (directory && directory->stage!=VM_DIRECTORY_CLOSED) {
        directory->pending=(pl_index_ref){0};directory->resource=(artifact_resource){0};
        directory->ticket=0u;directory->stage=VM_DIRECTORY_IDLE;
    }
}

int vm_directory_open(vm_directory *directory, const pl_index_ref *root,
    pl_u64 generation, pl_u32 maximum_object_bytes)
{
    if (!directory) return VM_DIRECTORY_ERROR_INPUT;
    int valid=root && !pl_index_ref_validate(root)
        && root->leaf_row_bytes==ARTIFACT_RESOURCE_BYTES && generation && maximum_object_bytes;
    pl_index_ref value={0};if(valid)value=*root;
    vm_directory_close(directory);
    if (!valid) return VM_DIRECTORY_ERROR_INPUT;
    directory->root=value;directory->generation=generation;
    directory->maximum_object_bytes=maximum_object_bytes;directory->stage=VM_DIRECTORY_IDLE;
    return 0;
}

int vm_directory_begin(vm_directory *directory, pl_u64 generation, pl_index_key key,
    pl_u32 expected_kind)
{
    if (!directory || directory->stage==VM_DIRECTORY_CLOSED || directory->stage>VM_DIRECTORY_READY)
        return VM_DIRECTORY_ERROR_INPUT;
    if (generation!=directory->generation) return VM_DIRECTORY_ERROR_STALE;
    if (expected_kind<ARTIFACT_RESOURCE_WASM_MODULE || expected_kind>ARTIFACT_RESOURCE_IMAGE_SOURCE)
        return VM_DIRECTORY_ERROR_INPUT;
    if (directory->stage==VM_DIRECTORY_NODE || directory->stage==VM_DIRECTORY_OBJECT)
        return VM_DIRECTORY_ERROR_BUSY;
    if (pl_index_key_compare(key,directory->root.first)<0
            || (expected_kind==ARTIFACT_RESOURCE_IMAGE_MODULE
                ? key.major>directory->root.last.major
                : pl_index_key_compare(key,directory->root.last)>0)) return PL_ERROR_INDEX_ABSENT;
    if (directory->sequence==~0ull) return VM_DIRECTORY_ERROR_EXHAUSTED;
    directory->key=key;directory->pending=directory->root;
    directory->kind=(pl_u8)expected_kind;
    directory->resource=(artifact_resource){0};directory->ticket=++directory->sequence;
    directory->stage=VM_DIRECTORY_NODE;
    return 0;
}

static int current(const vm_directory *directory,pl_u64 generation,pl_u64 ticket,pl_u32 stage)
{
    return directory && directory->stage==stage && generation
        && generation==directory->generation && ticket && ticket==directory->ticket;
}

int vm_directory_node(vm_directory *directory, pl_u64 generation, pl_u64 ticket,
    const pl_u8 *bytes, pl_u32 length)
{
    if (!current(directory,generation,ticket,VM_DIRECTORY_NODE)) return VM_DIRECTORY_ERROR_STALE;
    pl_index_node node;
    int status=pl_index_node_open(&directory->pending,bytes,length,&node);
    if (status) return status;
    if (directory->sequence==~0ull) return VM_DIRECTORY_ERROR_EXHAUSTED;
    if (node.level) {
        pl_index_ref next;
        status=directory->kind==ARTIFACT_RESOURCE_IMAGE_MODULE
            ?pl_index_select_floor_child(&node,directory->key,&next)
            :pl_index_select_child(&node,directory->key,&next);
        if (status) return status;
        directory->pending=next;directory->ticket=++directory->sequence;
        return 0;
    }
    const pl_u8 *row=0;artifact_resource resource;
    status=directory->kind==ARTIFACT_RESOURCE_IMAGE_MODULE
        ?pl_index_find_floor(&node,directory->key,&row):pl_index_find_row(&node,directory->key,&row);
    if (!status) status=artifact_resource_read(row,&resource);
    if (status) return status;
    if (resource.generation!=directory->generation) return VM_DIRECTORY_ERROR_STALE;
    if (resource.object.kind!=directory->kind) return PL_ERROR_INDEX;
    if(directory->kind==ARTIFACT_RESOURCE_IMAGE_MODULE
            && (resource.key.major!=directory->key.major || resource.key.minor>directory->key.minor
                || directory->key.minor>=resource.coordinate))return PL_ERROR_INDEX_ABSENT;
    if (resource.object.bytes>directory->maximum_object_bytes) return PL_ERROR_INDEX_RANGE;
    directory->resource=resource;directory->ticket=++directory->sequence;
    directory->stage=VM_DIRECTORY_OBJECT;return 1;
}

int vm_directory_object(vm_directory *directory, pl_u64 generation, pl_u64 ticket,
    const pl_u8 *bytes, pl_u32 length)
{
    if (!current(directory,generation,ticket,VM_DIRECTORY_OBJECT)) return VM_DIRECTORY_ERROR_STALE;
    if (!artifact_object_matches(&directory->resource.object,bytes,length)) return PL_ERROR_INDEX_DIGEST;
    directory->stage=VM_DIRECTORY_READY;return 0;
}
