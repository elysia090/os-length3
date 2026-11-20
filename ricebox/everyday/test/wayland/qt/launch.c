#include "../presenter.h"
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 2) return 8;
    int pair[2], status;
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) < 0) {
        perror("Qt Wayland socketpair");
        return 10;
    }
    pid_t child = fork();
    if (child < 0) { perror("Qt Wayland fork"); return 11; }
    if (!child) {
        close(pair[0]);
        close(STDIN_FILENO);
        char endpoint[32];
        snprintf(endpoint, sizeof endpoint, "%d", pair[1]);
        if (fcntl(pair[1], F_SETFD, 0) < 0 || setenv("WAYLAND_SOCKET", endpoint, 1) < 0) _exit(14);
        // This launcher runs with the native test's explicit environment. Its
        // only display connection is the endpoint created by this process.
        char *const args[] = {"/usr/lib/qt6/bin/qmlscene", "/tmp/rectangle.qml", NULL};
        execv(args[0], args);
        perror("Qt Wayland exec");
        _exit(15);
    }
    close(pair[1]);
    int server = guest_wayland_server(pair[0], argv[1]);
    if (waitpid(child, &status, 0) != child) { perror("Qt Wayland wait"); return 12; }
    if (server || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "Qt Wayland server %d; child status %d\n", server, status);
        return 13;
    }
    puts("QT_WAYLAND_WINDOW_CLOSED");
    return 0;
}
