#include "presenter.h"
#include <stdio.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/wait.h>

int main(int argc, char **argv) {
    if (argc != 2) return 8;
    int pair[2], status;
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) < 0) {
        perror("guest Wayland socketpair");
        return 10;
    }
    pid_t child = fork();
    if (child == 0) {
        close(pair[0]);
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
