#include "presenter.h"
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/wait.h>

static void exec_client(const char *path, int socket) {
    // The display endpoint is the sole deliberately inherited connection.
    // An unrelated descriptor stays close-on-exec, for the client's witness.
    int sentinel = open("/dev/null", O_RDONLY | O_CLOEXEC);
    int flags = fcntl(socket, F_GETFD);
    if (sentinel < 0 || flags < 0 || fcntl(socket, F_SETFD, flags & ~FD_CLOEXEC) < 0) _exit(14);
    close(STDIN_FILENO); // The separate client cannot receive the fixture control packets.
    char socket_value[32], sentinel_value[32], entry[64];
    snprintf(socket_value, sizeof socket_value, "%d", socket);
    snprintf(sentinel_value, sizeof sentinel_value, "%d", sentinel);
    snprintf(entry, sizeof entry, "WAYLAND_SOCKET=%s", socket_value);
    char *const args[] = {(char *)path, socket_value, sentinel_value, NULL};
    char *const env[] = {entry, NULL}; // No WAYLAND_DISPLAY or XDG_RUNTIME_DIR fallback.
    execve(path, args, env);
    perror("guest Wayland client exec");
    _exit(15);
}

int main(int argc, char **argv) {
    if (argc != 2 && argc != 3) return 8;
    int pair[2], status;
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) < 0) {
        perror("guest Wayland socketpair");
        return 10;
    }
    pid_t child = fork();
    if (child == 0) {
        close(pair[0]);
        if (argc == 3) exec_client(argv[2], pair[1]);
        _exit(guest_wayland_client(pair[1]));
    }
    if (child < 0) { perror("guest Wayland fork"); return 11; }
    close(pair[1]);
    int server = guest_wayland_server(pair[0], argv[1]);
    if (waitpid(child, &status, 0) != child) { perror("guest Wayland wait"); return 12; }
    if (server || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "guest Wayland server %d; child status %d\n", server, status);
        return 13;
    }
    puts("WAYLAND_WINDOW_CLOSED");
    return 37; // Match the existing demo's deliberately distinct successful exit.
}
