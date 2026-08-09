#include <stdint.h>
#include <stddef.h>

#include <lkl.h>
#include <lkl_host.h>


__attribute__((import_module("env"), import_name("nccc_call64")))
void nccc_call64(uint64_t *input, uint64_t *output);


static int block_capacity(struct lkl_disk disk, unsigned long long *capacity)
{
    uint64_t input[3] = {6, 1, (uint32_t)disk.fd};
    uint64_t output[1];

    nccc_call64(input, output);
    *capacity = output[0];
    return 0;
}


static int block_transfer(unsigned int operation, struct lkl_disk disk,
                          struct lkl_blk_req *request)
{
    uint64_t offset = request->sector * 512;
    int index;

    for (index = 0; index < request->count; ++index) {
        uint64_t input[6] = {
            6,
            operation,
            (uint32_t)disk.fd,
            offset,
            (uintptr_t)request->buf[index].iov_base,
            request->buf[index].iov_len,
        };
        uint64_t output[1];

        nccc_call64(input, output);
        if (output[0] != LKL_DEV_BLK_STATUS_OK)
            return output[0];
        offset += request->buf[index].iov_len;
    }
    return LKL_DEV_BLK_STATUS_OK;
}


static int block_request(struct lkl_disk disk, struct lkl_blk_req *request)
{
    uint64_t input[3] = {6, 4, (uint32_t)disk.fd};
    uint64_t output[1];

    switch (request->type) {
    case LKL_DEV_BLK_TYPE_READ:
        return block_transfer(2, disk, request);
    case LKL_DEV_BLK_TYPE_WRITE:
        return block_transfer(3, disk, request);
    case LKL_DEV_BLK_TYPE_FLUSH:
    case LKL_DEV_BLK_TYPE_FLUSH_OUT:
        nccc_call64(input, output);
        return output[0];
    default:
        return LKL_DEV_BLK_STATUS_UNSUP;
    }
}


struct lkl_dev_blk_ops lkl_dev_blk_ops = {
    .get_capacity = block_capacity,
    .request = block_request,
};

static struct lkl_disk root_disk = {
    .fd = 0,
    .ops = &lkl_dev_blk_ops,
};

static int root_disk_id = -1;


void lkl_perror(char *message, int error)
{
    (void)message;
    (void)error;
}


int atoi(const char *text)
{
    int value = 0;

    while (*text >= '0' && *text <= '9') {
        value = value * 10 + (*text - '0');
        ++text;
    }
    return value;
}


int qm_block_prepare(void)
{
    root_disk_id = lkl_disk_add(&root_disk);
    return root_disk_id;
}


int qm_rootfs_mount(void)
{
    char mount_point[32];
    long result;

    if (root_disk_id < 0)
        return root_disk_id;
    result = lkl_mount_dev(root_disk_id, 0, "ext4", LKL_MS_RDONLY, NULL,
                           mount_point, sizeof(mount_point));
    if (result < 0)
        return result;
    result = lkl_sys_chdir(mount_point);
    if (result < 0)
        return result;
    result = lkl_sys_chroot(".");
    if (result < 0)
        return result;
    return lkl_sys_chdir("/");
}


int qm_init_probe(void)
{
    static const unsigned char wasm_magic[4] = {0x00, 0x61, 0x73, 0x6d};
    char found[4];
    long descriptor;
    long count;
    int index;

    descriptor = lkl_sys_open("/init", LKL_O_RDONLY, 0);
    if (descriptor < 0)
        return descriptor;
    count = lkl_sys_read(descriptor, found, sizeof(found));
    lkl_sys_close(descriptor);
    if (count != sizeof(found))
        return count < 0 ? count : -LKL_ENOEXEC;
    for (index = 0; index < sizeof(found); ++index)
        if (found[index] != wasm_magic[index])
            return -LKL_ENOEXEC;
    return 0;
}


long qm_init_size(void)
{
    long descriptor;
    long size;

    descriptor = lkl_sys_open("/init", LKL_O_RDONLY, 0);
    if (descriptor < 0)
        return descriptor;
    size = lkl_sys_lseek(descriptor, 0, 2);
    lkl_sys_close(descriptor);
    return size;
}


int qm_init_read(void *destination, unsigned long size)
{
    char *output = destination;
    unsigned long total = 0;
    long descriptor;
    long count;

    descriptor = lkl_sys_open("/init", LKL_O_RDONLY, 0);
    if (descriptor < 0)
        return descriptor;
    while (total < size) {
        count = lkl_sys_read(descriptor, output + total, size - total);
        if (count <= 0) {
            lkl_sys_close(descriptor);
            return count < 0 ? count : -LKL_EIO;
        }
        total += count;
    }
    lkl_sys_close(descriptor);
    return 0;
}
