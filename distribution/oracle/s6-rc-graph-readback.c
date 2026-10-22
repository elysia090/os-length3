/* Differential input for the unchanged s6-rc dependency-closure object.
 * Both edge directions and every mask bit must close the same chain. */
#include <s6-rc/s6rc-db.h>
#include <s6-rc/s6rc-utils.h>
#include <stdio.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>

static int actual_database(const char *directory)
{
    s6rc_db_t db = {0};
    int fd = open(directory, O_RDONLY | O_DIRECTORY);
    if (fd < 0 || !s6rc_db_read_sizes(fd, &db)) return 3;
    unsigned n = db.nshort + db.nlong;
    if (!n || n > 1024 || db.ndeps > 4096 || db.nargvs > 4096
            || db.stringlen > 65536 || db.nproducers > 1024) return 4;
    s6rc_service_t services[n];
    const char *arguments[db.nargvs ? db.nargvs : 1];
    uint32_t dependencies[db.ndeps ? db.ndeps * 2 : 1];
    uint32_t producers[db.nproducers ? db.nproducers : 1];
    char strings[db.stringlen ? db.stringlen : 1];
    unsigned char bits[n];
    db.services = services;
    db.argvs = arguments;
    db.deps = dependencies;
    db.producers = producers;
    db.string = strings;
    if (s6rc_db_read(fd, &db) != 1 || close(fd)) return 5;
    printf("db: services=%u dependencies=%u\n", n, db.ndeps);
    for (unsigned i = 0; i < db.ndeps * 2; ++i) {
        printf("dependency[%u]=%u\n", i, db.deps[i]);
        if (db.deps[i] >= n) return 6;
    }
    memset(bits, 0, n);
    for (unsigned i = 0; i < n; ++i)
        if (services[i].name < db.stringlen
                && !strcmp(strings + services[i].name, "interactive-ready"))
            bits[i] = 16;
    s6rc_graph_closure(&db, bits, 4, 1);
    for (unsigned i = 0; i < n; ++i)
        if (bits[i] & 16) puts(strings + services[i].name);
    return 0;
}

int main(int argc, char **argv)
{
    if (argc == 2) return actual_database(argv[1]);
    if (argc != 1) return 7;
    s6rc_service_t service[65];
    uint32_t dependencies[128];
    unsigned char bits[65];
    for (unsigned n = 1; n <= 65; ++n) {
        memset(service, 0, sizeof service);
        for (unsigned i = 1; i < n; ++i) {
            dependencies[i - 1] = i - 1;
            dependencies[n - 1 + i - 1] = i - 1;
            for (unsigned h = 0; h != 2; ++h) {
                service[i].ndeps[h] = 1;
                service[i].deps[h] = i - 1;
            }
        }
        s6rc_db_t db = { .services = service, .nshort = n,
                         .ndeps = n - 1, .deps = dependencies };
        for (unsigned h = 0; h != 2; ++h)
            for (unsigned bit = 0; bit != 8; ++bit) {
                memset(bits, 0, sizeof bits);
                unsigned char mask = (unsigned char)(1u << bit);
                bits[n - 1] = mask;
                s6rc_graph_closure(&db, bits, bit, (int)h);
                for (unsigned i = 0; i < n; ++i)
                    if (bits[i] != mask) {
                        fprintf(stderr, "closure mismatch: n=%u h=%u bit=%u i=%u value=%u\n",
                                n, h, bit, i, (unsigned)bits[i]);
                        return 1;
                    }
                /* Re-closing the same graph must be idempotent. */
                s6rc_graph_closure(&db, bits, bit, (int)h);
                for (unsigned i = 0; i < n; ++i)
                    if (bits[i] != mask) return 2;
            }
    }
    puts("s6-rc graph closure: byte parity");
    return 0;
}
