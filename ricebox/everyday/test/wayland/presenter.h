#ifndef RICEBOX_WAYLAND_PRESENTER_H
#define RICEBOX_WAYLAND_PRESENTER_H

#include <stdint.h>

enum { DEFAULT_W = 32, DEFAULT_H = 24, MAX_W = 64, MAX_H = 48, LEFT_BUTTON = 0x110 };
int guest_wayland_client(int fd);
int guest_wayland_inherited(int expected);
int guest_wayland_server(int fd, const char *mirror);
#endif
