// fork, exec, pipe, dup2, wait and files, checked through output only.
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "child") == 0) {
        char buf[64] = {0};
        ssize_t n = read(0, buf, sizeof buf - 1);
        printf("child read %zd: %s", n, buf);
        return 5;
    }
    setvbuf(stdout, 0, _IONBF, 0);
    int p[2];
    if (pipe(p)) return 1;
    pid_t pid = fork();
    if (pid == 0) {
        close(p[0]);
        write(p[1], "through the pipe\n", 17);
        _exit(9);
    }
    close(p[1]);
    char buf[64] = {0};
    ssize_t n = read(p[0], buf, sizeof buf - 1);
    int status;
    pid_t got = waitpid(pid, &status, 0);
    printf("parent read %zd: %s", n, buf);
    printf("waited same=%d exit=%d\n", got == pid, WEXITSTATUS(status));

    // exec ourselves with a pipe on stdin
    int q[2];
    pipe(q);
    write(q[1], "hello exec\n", 11);
    close(q[1]);
    pid = fork();
    if (pid == 0) {
        dup2(q[0], 0);
        execl(argv[0], argv[0], "child", (char *)0);
        _exit(127);
    }
    close(q[0]);
    waitpid(pid, &status, 0);
    printf("exec child exit=%d\n", WEXITSTATUS(status));

    int fd = open("/tmp/xlat-procs-test", O_CREAT | O_TRUNC | O_RDWR, 0644);
    write(fd, "0123456789", 10);
    lseek(fd, 3, SEEK_SET);
    char c[4] = {0};
    read(fd, c, 3);
    struct stat st;
    fstat(fd, &st);
    printf("file %s size=%lld\n", c, (long long)st.st_size);
    close(fd);
    unlink("/tmp/xlat-procs-test");
    printf("gone=%d\n", access("/tmp/xlat-procs-test", F_OK) != 0);
    return 0;
}
