#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/wait.h>
#include <unistd.h>

/* Control only: ships in neither measured input set. No compiler runs in this process. */
static const char *const ns[] = {"mnt", "user", "pid", "net", "ipc", "uts", "cgroup"};
static const char start[] = "RX_ISOLATION_ENTERED";
static const char finish[] = "RX_ISOLATION_OK";

static bool private_namespaces(char **host) {
    for (size_t i = 0; i < sizeof(ns) / sizeof(ns[0]); ++i) {
        char path[64], identity[96];
        struct stat s;
        snprintf(path, sizeof(path), "/proc/self/ns/%s", ns[i]);
        if (stat(path, &s)) return false;
        snprintf(identity, sizeof(identity), "%ju:%ju", (uintmax_t)s.st_dev, (uintmax_t)s.st_ino);
        uintmax_t d, n;
        char trailing;
        if (sscanf(host[i], "%ju:%ju%c", &d, &n, &trailing) != 2 || !n ||
            strcmp(identity, host[i]) == 0) return false;
    }
    return true;
}

static bool private_privileges(void) {
    if (getuid() || geteuid() || getgid() || getegid()) return false;
    FILE *f = fopen("/proc/self/status", "re");
    if (!f) return false;
    static const char *const caps[] = {"CapInh:", "CapPrm:", "CapEff:", "CapBnd:", "CapAmb:"};
    char line[256];
    unsigned seen = 0;
    bool nnp = false, invalid = false;
    while (!invalid && fgets(line, sizeof(line), f)) {
        for (size_t i = 0; i < sizeof(caps) / sizeof(caps[0]); ++i) {
            size_t len = strlen(caps[i]);
            if (strncmp(caps[i], line, len)) continue;
            uintmax_t val;
            char extra;
            if ((seen & (1u << i)) || sscanf(line + len, " %jx %c", &val, &extra) != 1 || val)
                invalid = true;
            seen |= 1u << i;
        }
        if (strncmp(line, "NoNewPrivs:", 11) == 0) {
            int val;
            char extra;
            if (nnp || sscanf(line + 11, " %d %c", &val, &extra) != 1 || val != 1)
                invalid = true;
            nnp = true;
        }
    }
    bool ok = !invalid && !ferror(f) && nnp && seen == 31;
    return fclose(f) == 0 && ok;
}

static bool mount_mode(const char *path, bool readonly) {
    struct statvfs s;
    return statvfs(path, &s) == 0 && ((s.f_flag & ST_RDONLY) != 0) == readonly;
}

static bool input_byte(const char *path) {
    int fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return false;
    struct stat s;
    char b;
    bool ok = fstat(fd, &s) == 0 && S_ISREG(s.st_mode) && read(fd, &b, 1) == 1;
    return close(fd) == 0 && ok;
}

int main(int argc, char **argv) {
    if (setvbuf(stdout, NULL, _IONBF, 0) || puts(start) < 0) return 79;
    if (argc != 9 || (strcmp(argv[1], "timer") && strcmp(argv[1], "trial"))) return 79;
    bool trial = strcmp(argv[1], "trial") == 0;
    if (!private_namespaces(argv + 2)) return 71;
    if (!private_privileges()) return 72;
    if (!mount_mode("/", true) || !mount_mode(".", false) ||
        (trial && !mount_mode("/tmp/rx-in", true))) return 73;

    char cwd[128];
    if (!getcwd(cwd, sizeof(cwd)) || strcmp(cwd, trial ? "/tmp/rx-out" : "/tmp")) return 74;
    if (!input_byte(trial ? "/tmp/rx-in/rx-time.c" : "./rx-time.c")) return 74;

    int nullfd = open("/dev/null", O_WRONLY | O_CLOEXEC);
    if (nullfd < 0 || write(nullfd, "", 0) != 0 || close(nullfd)) return 75;

    static const char name[] = ".rx-isolation-sentinel";
    pid_t child = fork();
    if (child == -1) return 76;
    if (!child) {
        int fd = open(name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
        if (fd < 0 || write(fd, "R", 1) != 1 || close(fd)) _exit(1);
        _exit(0);
    }
    int status;
    pid_t got;
    do { got = waitpid(child, &status, 0); } while (got == -1 && errno == EINTR);
    if (got != child || !WIFEXITED(status) || WEXITSTATUS(status) != 0) return 76;
    if (!input_byte(name) || unlink(name)) return 76;
    return puts(finish) >= 0 ? 0 : 79;
}
