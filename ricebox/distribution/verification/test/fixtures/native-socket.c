// Synthetic endpoints. The same static ELF runs on both sides; no display or real host service.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/un.h>
#include <unistd.h>

#define HOST_SOCKET "ricebox-proof.sock"
#define GUEST_SOCKET "/run/" HOST_SOCKET
#define NEIGHBOR "/run/not-lent"
enum { SIZE = 4096, SEALS = F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_SEAL };

static void require(int yes, const char *message) {
    if (!yes) {
        fprintf(stderr, "native socket proof: %s\n", message);
        exit(1);
    }
}

static void check(int yes, const char *call) {
    if (!yes) {
        perror(call);
        exit(1);
    }
}

static void absent(const char *path) {
    struct stat stat;
    require(lstat(path, &stat) < 0 && errno == ENOENT, path);
}

static char *map(int fd) {
    char *bytes = mmap(NULL, SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    check(bytes != MAP_FAILED, "mmap shared memfd");
    return bytes;
}

static void send_fd(int link, int fd, char token) {
    union { struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(int))]; } control = {0};
    struct iovec io = {&token, 1};
    struct msghdr msg = {.msg_iov = &io, .msg_iovlen = 1,
        .msg_control = control.bytes, .msg_controllen = sizeof control.bytes};
    struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
    c->cmsg_level = SOL_SOCKET;
    c->cmsg_type = SCM_RIGHTS;
    c->cmsg_len = CMSG_LEN(sizeof fd);
    memcpy(CMSG_DATA(c), &fd, sizeof fd);
    check(sendmsg(link, &msg, MSG_NOSIGNAL) == 1, "sendmsg SCM_RIGHTS");
}

static char *receive(int link, char expected_token) {
    char token;
    union { struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(int))]; } control = {0};
    struct iovec io = {&token, 1};
    struct msghdr msg = {.msg_iov = &io, .msg_iovlen = 1,
        .msg_control = control.bytes, .msg_controllen = sizeof control.bytes};
    ssize_t n = recvmsg(link, &msg, MSG_CMSG_CLOEXEC);
    check(n >= 0, "recvmsg SCM_RIGHTS");
    require(n == 1 && token == expected_token && !(msg.msg_flags & MSG_CTRUNC), "expected one FD message");
    struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
    require(c && c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS &&
            c->cmsg_len == CMSG_LEN(sizeof(int)) && !CMSG_NXTHDR(&msg, c), "expected exactly one SCM_RIGHTS descriptor");
    int fd;
    memcpy(&fd, CMSG_DATA(c), sizeof fd);
    struct stat stat;
    check(fstat(fd, &stat) == 0, "fstat received FD");
    require(stat.st_size == SIZE && fcntl(fd, F_GET_SEALS) == SEALS &&
            fcntl(fd, F_GETFD) == FD_CLOEXEC, "received wrong size, seals or FD flags");
    char *bytes = map(fd);
    check(close(fd) == 0, "close received FD");
    return bytes;
}

static char *offer(int link, char value) {
    int fd = memfd_create("ricebox-proof", MFD_CLOEXEC | MFD_ALLOW_SEALING);
    check(fd >= 0, "memfd_create");
    check(ftruncate(fd, SIZE) == 0, "ftruncate memfd");
    char *bytes = map(fd);
    *bytes = value;
    check(fcntl(fd, F_ADD_SEALS, SEALS) == 0, "set size seals");
    send_fd(link, fd, value);
    check(close(fd) == 0, "close creator FD");
    return bytes;
}

static void exchange(int link, int host) {
    // Both creators close their FDs after sending, retaining only their shared mappings.
    char *guest, *peer;
    if (host) {
        guest = receive(link, 'g');
        require(*guest == 'g', "host did not see initial guest bytes");
        *guest = 'H';
        peer = offer(link, 'h');
        char ack;
        check(read(link, &ack, 1) == 1, "read guest acknowledgement");
        require(ack == '!' && *peer == 'G', "host did not see guest writes after closing its FD");
    } else {
        guest = offer(link, 'g');
        peer = receive(link, 'h');
        require(*guest == 'H' && *peer == 'h', "guest did not see host writes and initial host bytes");
        *peer = 'G';
        check(send(link, "!", 1, MSG_NOSIGNAL) == 1, "acknowledge host memfd");
    }
    check(munmap(guest, SIZE) == 0 && munmap(peer, SIZE) == 0 && close(link) == 0, "close exchange");
}

int main(int argc, char **argv) {
    require(argc == 2, "expected host, baseline, unlent or lent");
    const int host = strcmp(argv[1], "host") == 0;
    const int unlent = strcmp(argv[1], "unlent") == 0;
    if (host) {
        // Bound readiness/accept/FD exchange beyond both separate 15-second guest deadlines.
        sigset_t signals;
        check(sigemptyset(&signals) == 0 && sigaddset(&signals, SIGALRM) == 0, "prepare host alarm");
        check(signal(SIGALRM, SIG_DFL) != SIG_ERR && sigprocmask(SIG_UNBLOCK, &signals, NULL) == 0, "enable host alarm");
        alarm(45);
    } else {
        require(getpid() == 1, "probe must be the installed root's PID 1");
        absent(NEIGHBOR);
        if (strcmp(argv[1], "baseline") == 0) {
            absent(GUEST_SOCKET);
            puts("GUEST_BASELINE_SOCKET_ABSENT");
            return 0;
        }
        if (unlent) {
            absent(GUEST_SOCKET);
        } else {
            require(strcmp(argv[1], "lent") == 0, "expected lent guest");
            struct stat stat;
            check(lstat(GUEST_SOCKET, &stat) == 0, "lstat lent socket");
            require(S_ISSOCK(stat.st_mode), "lent path is not a socket");
            struct statvfs mount;
            check(statvfs(GUEST_SOCKET, &mount) == 0, "statvfs lent socket");
            require(mount.f_flag & ST_RDONLY, "socket mount must be read-only");
            check(statvfs("/run", &mount) == 0, "statvfs guest /run");
            require(!(mount.f_flag & ST_RDONLY), "the guest /run must remain writable");
        }
    }

    int link = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    check(link >= 0, host ? "host socket(AF_UNIX)" : "guest socket(AF_UNIX)");
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    strcpy(address.sun_path, host ? HOST_SOCKET : GUEST_SOCKET);
    if (host) {
        check(bind(link, (struct sockaddr *)&address, sizeof address) == 0, "bind pathname socket");
        check(listen(link, 1) == 0, "listen");
        puts("READY");
        fflush(stdout);
        int client = accept4(link, NULL, NULL, SOCK_CLOEXEC);
        check(client >= 0, "accept");
        check(close(link) == 0, "close listener");
        link = client;
    } else {
        int connected = connect(link, (struct sockaddr *)&address, sizeof address);
        if (unlent) {
            require(connected < 0, "unexpectedly connected to the unlent socket");
            check(errno == ENOENT, "unlent socket must fail to connect with ENOENT");
            check(close(link) == 0, "close unlent test socket");
            puts("GUEST_ACTIVE_HOST_SOCKET_UNLENT");
            return 0;
        }
        check(connected == 0, "connect lent pathname socket");
    }
    exchange(link, host);
    puts(host ? "HOST_SCM_RIGHTS_MEMFD_OK" : "GUEST_SCM_RIGHTS_MEMFD_OK");
    return 0;
}
