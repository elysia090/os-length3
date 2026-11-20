#include "presenter.h"
#include <wayland-client.h>
#include "generated/xdg-client.h"
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>
#include <fcntl.h>

struct Client {
    struct wl_compositor *compositor;
    struct wl_shm *shm;
    struct wl_seat *seat;
    struct wl_pointer *pointer;
    struct wl_surface *surface;
    struct xdg_wm_base *wm;
    struct xdg_surface *role;
    struct xdg_toplevel *window;
    int width, height, pending_width, pending_height;
    int px, py, marker_x, marker_y;
    bool offered, entered, closed, failed;
    unsigned pointer_events, configs, done, released, published;
};
struct Hold {
    void *data;
    size_t length;
    struct Client *client;
};
static void release(void *arg, struct wl_buffer *buffer) {
    struct Hold *hold = arg;
    hold->client->released++;
    wl_buffer_destroy(buffer);
    munmap(hold->data, hold->length);
    free(hold);
}
static const struct wl_buffer_listener released = { .release = release };
static void done(void *arg, struct wl_callback *cb, uint32_t serial) {
    struct Client *c = arg;
    if (!serial) c->failed = true;
    ++c->done;
    wl_callback_destroy(cb);
}
static const struct wl_callback_listener callback = { .done = done };

static void draw(struct Client *c) {
    // Deliberately use a padded stride and a non-alpha X byte so the
    // server's pixel witness cannot accidentally assume tight RGBA.
    int stride = c->width * 4 + 12, length = stride * c->height;
    int fd = memfd_create("guest-wayland-presenter", MFD_CLOEXEC | MFD_ALLOW_SEALING);
    if (fd < 0) { c->failed = true; return; }
    if (ftruncate(fd, length) < 0 || fcntl(fd, F_ADD_SEALS, F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_SEAL) < 0) {
        close(fd); c->failed = true; return;
    }
    unsigned char *data = mmap(NULL, (size_t)length, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (data == MAP_FAILED) { close(fd); c->failed = true; return; }
    memset(data, 0x6a, (size_t)length);
    for (int y = 0; y < c->height; ++y) {
        for (int x = 0; x < c->width; ++x) {
            int dx = x - c->marker_x, dy = y - c->marker_y;
            bool mark = c->marker_x >= 0 && dx * dx + dy * dy <= 4;
            uint32_t r = mark ? 248u : (unsigned)(18 + 2 * x);
            uint32_t g = mark ? 61u : (unsigned)(28 + 3 * y);
            uint32_t b = mark ? 105u : (unsigned)(42 + (x ^ y));
            ((uint32_t *)(data + y * stride))[x] = (0x4du << 24) | (r << 16) | (g << 8) | b;
        }
    }
    struct wl_shm_pool *pool = wl_shm_create_pool(c->shm, fd, length);
    close(fd);
    if (!pool) { munmap(data, (size_t)length); c->failed = true; return; }
    struct wl_buffer *buffer = wl_shm_pool_create_buffer(pool, 0, c->width, c->height, stride, WL_SHM_FORMAT_XRGB8888);
    wl_shm_pool_destroy(pool);
    struct Hold *hold = malloc(sizeof *hold);
    if (!buffer || !hold) {
        if (buffer) wl_buffer_destroy(buffer);
        munmap(data, (size_t)length); free(hold); c->failed = true; return;
    }
    *hold = (struct Hold){data, (size_t)length, c};
    if (wl_buffer_add_listener(buffer, &released, hold) < 0) {
        wl_buffer_destroy(buffer); munmap(data, (size_t)length); free(hold); c->failed = true; return;
    }
    struct wl_callback *request = wl_surface_frame(c->surface);
    if (!request || wl_callback_add_listener(request, &callback, c) < 0) { c->failed = true; return; }
    wl_surface_attach(c->surface, buffer, 0, 0);
    wl_surface_damage(c->surface, 0, 0, c->width, c->height);
    wl_surface_commit(c->surface);
    c->published++;
}

static void config(void *arg, struct xdg_surface *role, uint32_t serial) {
    struct Client *c = arg;
    if (c->pending_width < 1 || c->pending_width > MAX_W || c->pending_height < 1 || c->pending_height > MAX_H) {
        c->failed = true; return;
    }
    xdg_surface_ack_configure(role, serial);
    c->width = c->pending_width; c->height = c->pending_height;
    c->marker_x = c->marker_y = -1;
    c->configs++;
    draw(c);
}
static const struct xdg_surface_listener role_listen = { .configure = config };
static void dims(void *arg, struct xdg_toplevel *t, int32_t w, int32_t h, struct wl_array *states) {
    (void)t; (void)states;
    struct Client *c = arg;
    c->pending_width = w; c->pending_height = h;
}
static void close_window(void *arg, struct xdg_toplevel *t) {
    (void)t; ((struct Client *)arg)->closed = true;
}
static const struct xdg_toplevel_listener top = {.configure = dims, .close = close_window};
static void ping(void *arg, struct xdg_wm_base *wm, uint32_t serial) {
    (void)arg; xdg_wm_base_pong(wm, serial);
}
static const struct xdg_wm_base_listener wm_listen = {.ping = ping};

static void moved(struct Client *c, wl_fixed_t x, wl_fixed_t y) {
    c->px = wl_fixed_to_int(x); c->py = wl_fixed_to_int(y);
}
static void enter(void *arg, struct wl_pointer *p, uint32_t serial, struct wl_surface *s, wl_fixed_t x, wl_fixed_t y) {
    (void)p; (void)serial;
    struct Client *c = arg;
    c->entered = s == c->surface; moved(c, x, y);
}
static void leave(void *arg, struct wl_pointer *p, uint32_t serial, struct wl_surface *s) {
    (void)p; (void)serial; (void)s; ((struct Client *)arg)->entered = false;
}
static void motion(void *arg, struct wl_pointer *p, uint32_t time, wl_fixed_t x, wl_fixed_t y) {
    (void)p; (void)time; moved(arg, x, y);
}
static void button(void *arg, struct wl_pointer *p, uint32_t serial, uint32_t time, uint32_t b, uint32_t state) {
    (void)p; (void)serial; (void)time;
    struct Client *c = arg;
    if (c->entered && b == LEFT_BUTTON && state == WL_POINTER_BUTTON_STATE_PRESSED &&
        c->px >= 0 && c->px < c->width && c->py >= 0 && c->py < c->height) {
        c->marker_x = c->px; c->marker_y = c->py; c->pointer_events++;
        draw(c);
    }
}
static const struct wl_pointer_listener pointer_listen = {.enter = enter, .leave = leave, .motion = motion, .button = button};
static void capa(void *arg, struct wl_seat *s, uint32_t allowed) {
    struct Client *c = arg;
    if ((allowed & WL_SEAT_CAPABILITY_POINTER) && !c->pointer) {
        c->pointer = wl_seat_get_pointer(s);
        if (!c->pointer || wl_pointer_add_listener(c->pointer, &pointer_listen, c) < 0) c->failed = true;
    }
}
static const struct wl_seat_listener seat = {.capabilities = capa};

static void format(void *arg, struct wl_shm *shm, uint32_t f) {
    (void)shm;
    if (f == WL_SHM_FORMAT_XRGB8888) ((struct Client *)arg)->offered = true;
}
static const struct wl_shm_listener shm_listen = {.format = format};
static void global(void *arg, struct wl_registry *r, uint32_t id, const char *iface, uint32_t version) {
    struct Client *c = arg;
    if (!version) return;
    if (!strcmp(iface, wl_compositor_interface.name)) c->compositor = wl_registry_bind(r, id, &wl_compositor_interface, 1);
    else if (!strcmp(iface, wl_shm_interface.name)) {
        c->shm = wl_registry_bind(r, id, &wl_shm_interface, 1);
        if (!c->shm || wl_shm_add_listener(c->shm, &shm_listen, c) < 0) c->failed = true;
    } else if (!strcmp(iface, xdg_wm_base_interface.name)) {
        c->wm = wl_registry_bind(r, id, &xdg_wm_base_interface, 1);
        if (!c->wm || xdg_wm_base_add_listener(c->wm, &wm_listen, c) < 0) c->failed = true;
    } else if (!strcmp(iface, wl_seat_interface.name)) {
        c->seat = wl_registry_bind(r, id, &wl_seat_interface, 1);
        if (!c->seat || wl_seat_add_listener(c->seat, &seat, c) < 0) c->failed = true;
    }
}
static void removed(void *arg, struct wl_registry *r, uint32_t id) {(void)arg; (void)r; (void)id;}
static const struct wl_registry_listener registry = {.global = global, .global_remove = removed};

static int run_client(struct wl_display *display) {
    struct Client c = {.marker_x = -1, .marker_y = -1};
    if (!display) return 21;
    struct wl_registry *r = wl_display_get_registry(display);
    if (!r || wl_registry_add_listener(r, &registry, &c) < 0 || wl_display_roundtrip(display) < 0 ||
        !c.compositor || !c.shm || !c.wm || !c.seat || wl_display_roundtrip(display) < 0 || !c.offered) return 22;
    c.surface = wl_compositor_create_surface(c.compositor);
    c.role = c.surface ? xdg_wm_base_get_xdg_surface(c.wm, c.surface) : NULL;
    c.window = c.role ? xdg_surface_get_toplevel(c.role) : NULL;
    if (!c.window || xdg_surface_add_listener(c.role, &role_listen, &c) < 0 ||
        xdg_toplevel_add_listener(c.window, &top, &c) < 0) return 23;
    wl_surface_commit(c.surface); // Map handshake first, no buffer.
    while (!c.closed && !c.failed) if (wl_display_dispatch(display) < 0) { c.failed = true; break; }
    if (c.failed || c.done != c.published || c.released != c.published || c.configs < 1 || c.published < 1) {
        fprintf(stderr,"Wayland client failed: %u commits %u done %u released\n",c.published,c.done,c.released);
        return 24;
    }
    printf("WAYLAND_CLIENT pointer=%u configure=%u frame_done=%u releases=%u\n", c.pointer_events, c.configs, c.done, c.released);
    fflush(stdout);
    if (c.pointer) wl_pointer_destroy(c.pointer);
    wl_seat_destroy(c.seat);
    xdg_toplevel_destroy(c.window);
    xdg_surface_destroy(c.role);
    wl_surface_destroy(c.surface);
    xdg_wm_base_destroy(c.wm);
    wl_shm_destroy(c.shm);
    wl_compositor_destroy(c.compositor);
    wl_registry_destroy(r);
    if (wl_display_roundtrip(display) < 0) return 25;
    wl_display_disconnect(display);
    return 0;
}


int guest_wayland_client(int fd) {
    return run_client(wl_display_connect_to_fd(fd));
}

int guest_wayland_inherited(int expected) {
    struct wl_display *display = wl_display_connect(NULL);
    if (!display) return 26;
    int flags = fcntl(expected, F_GETFD);
    if (wl_display_get_fd(display) != expected || getenv("WAYLAND_SOCKET") || flags < 0 || !(flags & FD_CLOEXEC)) {
        wl_display_disconnect(display);
        return 27;
    }
    puts("WAYLAND_SOCKET_CONSUMED close_on_exec=1");
    if (fflush(stdout) != 0) { wl_display_disconnect(display); return 28; }
    return run_client(display);
}
