#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include "presenter.h"

/* The client starts separately and finds this socket inside the guest VFS. */
int main(int argc, char **argv) {
    if (argc != 3) return 2;
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    size_t length = strlen(argv[1]) + 1;
    if (length > sizeof address.sun_path) return 2;
    memcpy(address.sun_path, argv[1], length);
    int listener = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (listener < 0) { perror("socket"); return 3; }
    if (bind(listener, (struct sockaddr *)&address, offsetof(struct sockaddr_un, sun_path) + length) < 0 ||
        listen(listener, 1) < 0) {
        perror("Wayland listener");
        close(listener);
        return 4;
    }
    puts("WAYLAND_LISTENER_READY");
    fflush(stdout);
    int client = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
    close(listener);
    if (client < 0) { perror("accept4"); return 5; }
    return guest_wayland_server(client, argv[2]);
}
