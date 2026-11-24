#include "presenter.h"
#include <wayland-server.h>
#include "generated/xdg-server.h"
#ifdef EVERYDAY_TEST_LAYER
#include "generated/layer-server.h"
#endif
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

struct Server {
    struct wl_display *display;
    struct wl_client *client;
    struct wl_event_source *input;
    struct wl_resource *surface, *role, *window, *pointer, *buffer, *callback;
    struct wl_resource *last_buffer;
    struct wl_listener last_buffer_gone;
#ifdef EVERYDAY_TEST_LAYER
    struct wl_resource *layer, *output;
    uint32_t anchor;
#endif
    struct wl_listener gone;
    char name[256], temporary[256];
    int width, height, pending_width, pending_height;
    int damage_width, damage_height;
    uint32_t configured, acknowledged, frames, pointer_serial;
    unsigned char command[3];
    unsigned n;
    bool client_gone, pointer_entered, closing, detached, failed;
};

static void fail(struct Server *s, const char *message) {
    fprintf(stderr, "Wayland presenter: %s\n", message);
    s->failed = true;
}
static void u32le(unsigned char *p, uint32_t n) {
    p[0]=n; p[1]=n>>8; p[2]=n>>16; p[3]=n>>24;
}
static uint32_t serial(struct Server *s) {return wl_display_next_serial(s->display);}
static int write_all(int fd, const unsigned char *p, size_t n) {
    while (n != 0) {
        ssize_t v=write(fd,p,n);
        if (v < 0 && errno == EINTR) continue;
        if (v <= 0) return -1;
        p+=v; n-=(size_t)v;
    }
    return 0;
}

// Only the opt-in alpha fixtures expose straight RGBA from premultiplied SHM.
static bool alpha_witness(uint32_t format) {
#if defined(EVERYDAY_TEST_QUICKSHELL) || defined(EVERYDAY_TEST_ALPHA_FIXTURE)
    return format==WL_SHM_FORMAT_ARGB8888;
#else
    (void)format;
    return false;
#endif
}

static unsigned char straight(unsigned char premultiplied, unsigned char alpha) {
    if (!alpha) return 0;
    unsigned value = ((unsigned)premultiplied * 255 + alpha / 2) / alpha;
    return value > 255 ? 255 : value;
}

static bool mirror_commit(struct Server *s, struct wl_shm_buffer *buffer) {
    const int w=wl_shm_buffer_get_width(buffer), h=wl_shm_buffer_get_height(buffer), stride=wl_shm_buffer_get_stride(buffer);
    const uint32_t format=wl_shm_buffer_get_format(buffer);
    const bool alpha=alpha_witness(format);
#ifdef EVERYDAY_TEST_ALPHA_FIXTURE
    if (!alpha) return false;
#endif
    if (w != s->width || h != s->height || w < 1 || w > MAX_W || h < 1 || h > MAX_H ||
        stride < w*4 || stride > MAX_W*4+12 || (format != WL_SHM_FORMAT_XRGB8888 && !alpha) ||
        s->damage_width != w || s->damage_height != h || s->frames == UINT32_MAX) return false;
    unsigned char frame[16 + MAX_W*MAX_H*4];
    memcpy(frame,"RBF1",4); u32le(frame+4,s->frames+1); u32le(frame+8,w); u32le(frame+12,h);
    // This is the ONLY producer of mirror bytes. Read the submitted wl_shm
    // buffer while its usage is owned; there is no host/test redraw fallback.
    wl_shm_buffer_begin_access(buffer);
    const unsigned char *data=wl_shm_buffer_get_data(buffer);
    for (int y=0;y<h;y++) for (int x=0;x<w;x++) {
        const unsigned char *b=data+y*stride+4*x;
        unsigned char *p=frame+16+(y*w+x)*4;
        if(alpha) {
            p[0]=straight(b[2],b[3]); p[1]=straight(b[1],b[3]);
            p[2]=straight(b[0],b[3]); p[3]=b[3];
        } else {
            p[0]=b[2]; p[1]=b[1]; p[2]=b[0]; p[3]=255;
        }
    }
    wl_shm_buffer_end_access(buffer);
    int fd=open(s->temporary,O_CREAT|O_TRUNC|O_WRONLY|O_CLOEXEC,0600);
    if (fd<0) return false;
    int written=write_all(fd,frame,16+(size_t)w*h*4), closed=close(fd);
    if (written<0 || closed<0 || rename(s->temporary,s->name)<0) {unlink(s->temporary); return false;}
    s->frames++;
    if(alpha) puts("WAYLAND_ALPHA format=argb8888");
    printf("WAYLAND_COMMIT seq=%u size=%dx%d configure=%u pointer=%u stride=%d\n",
           s->frames,w,h,s->acknowledged,s->pointer_serial,stride);
    return fflush(stdout) == 0;
}

static bool layer_active(const struct Server *s) {
#ifdef EVERYDAY_TEST_LAYER
    return s->layer != NULL;
#else
    (void)s;
    return false;
#endif
}
static void close_window(struct Server *s) {
    s->closing=true;
#ifdef EVERYDAY_TEST_LAYER
    if(s->layer) {zwlr_layer_surface_v1_send_closed(s->layer);return;}
#endif
    if(s->window) xdg_toplevel_send_close(s->window);
}

static bool configure(struct Server *s, int w, int h) {
    if ((!layer_active(s) && (!s->role || !s->window)) || s->configured != s->acknowledged ||
        w < 1 || w > MAX_W || h < 1 || h > MAX_H) return false;
#ifdef EVERYDAY_TEST_LAYER
    if(s->layer) {
        if(s->anchor != (ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP|ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT)) return false;
        if(!s->configured) puts("WAYLAND_LAYER surface=top anchors=top-left output=explicit scope=ricebox-layer-proof");
        s->configured=serial(s); s->pending_width=w; s->pending_height=h;
        zwlr_layer_surface_v1_send_configure(s->layer,s->configured,w,h);
        return true;
    }
#endif
    struct wl_array states;
    wl_array_init(&states);
    s->configured=serial(s); s->pending_width=w; s->pending_height=h;
    xdg_toplevel_send_configure(s->window,w,h,&states);
    xdg_surface_send_configure(s->role,s->configured);
    wl_array_release(&states);
    return true;
}

static void run_command(struct Server *s) {
    int x=s->command[1], y=s->command[2];
    if (s->closing || s->configured!=s->acknowledged || (!s->window && !layer_active(s)) || !s->frames) return;
    switch (s->command[0]) {
    case 1:
        if (!s->pointer || x>=s->width || y>=s->height) break;
        if (!s->pointer_entered) {
            wl_pointer_send_enter(s->pointer,serial(s),s->surface,wl_fixed_from_int(x),wl_fixed_from_int(y));
            s->pointer_entered=true;
        }
        s->pointer_serial=serial(s);
        wl_pointer_send_motion(s->pointer,s->pointer_serial,wl_fixed_from_int(x),wl_fixed_from_int(y));
        wl_pointer_send_button(s->pointer,s->pointer_serial,s->pointer_serial,LEFT_BUTTON,WL_POINTER_BUTTON_STATE_PRESSED);
        wl_pointer_send_button(s->pointer,serial(s),s->pointer_serial,LEFT_BUTTON,WL_POINTER_BUTTON_STATE_RELEASED);
        return;
    case 2:
        if (configure(s,x,y)) return;
        break;
    case 3:
        close_window(s);
        return;
    default:
        break;
    }
    puts("WAYLAND_CONTROL_REFUSED");
    fflush(stdout);
}

static int input_ready(int fd, uint32_t mask, void *arg) {
    struct Server *s=arg;
    if (mask & (WL_EVENT_ERROR | WL_EVENT_HANGUP)) {
        close_window(s);
        return 0;
    }
    ssize_t n=read(fd,s->command+s->n,sizeof s->command-s->n);
    if(n<0) { if(errno!=EINTR && errno!=EAGAIN) fail(s,"cannot read fixture input"); return 0;}
    if(n==0) { close_window(s); return 0;}
    s->n+=(unsigned)n;
    if(s->n==sizeof s->command) {s->n=0; run_command(s);}
    return 0;
}

static void destroy(struct wl_client *client, struct wl_resource *r) {(void)client; wl_resource_destroy(r);}
static void attach(struct wl_client *client, struct wl_resource *r, struct wl_resource *b, int32_t x, int32_t y) {
    (void)client;
    struct Server *s=wl_resource_get_user_data(r);
    if(x || y || s->buffer || s->detached) {fail(s,"invalid demo attach");return;}
    if(!b) {
        if(!s->closing || s->window || s->role || layer_active(s) || s->callback) {fail(s,"unexpected detach");return;}
        // Qt drops the old buffer when closing its destroyed xdg role.
        s->detached=true;
        return;
    }
    s->buffer=b;
}
static void damage(struct wl_client *client, struct wl_resource *r, int32_t x,int32_t y,int32_t w,int32_t h) {
    (void)client;
    struct Server *s=wl_resource_get_user_data(r);
    if(x || y) {fail(s,"invalid damage origin"); return;}
    s->damage_width=w; s->damage_height=h;
}
/* The renderer does not composite behind this one client, so opaque regions
 * are advisory. Implement region lifetimes without using the hint. */
static void opaque_hint(struct wl_client *c, struct wl_resource *s, struct wl_resource *region) {
    (void)c;(void)s;(void)region;
}
static void frame(struct wl_client *c, struct wl_resource *r, uint32_t id) {
    struct Server *s=wl_resource_get_user_data(r);
    if(s->callback) {fail(s,"duplicate frame callback");return;}
    s->callback=wl_resource_create(c,&wl_callback_interface,1,id);
    if(!s->callback) wl_client_post_no_memory(c);
}
static void last_buffer_destroyed(struct wl_listener *listener, void *data) {
    (void)data;
    struct Server *s=wl_container_of(listener,s,last_buffer_gone);
    s->last_buffer=NULL;
}
static void commit(struct wl_client *c, struct wl_resource *r) {
    (void)c;
    struct Server *s=wl_resource_get_user_data(r);
    if(!s->configured && !s->buffer) {
        if(!configure(s,DEFAULT_W,DEFAULT_H)) fail(s,"invalid xdg initial commit");
        return;
    }
    if(s->failed) return;
    if(s->detached) {s->detached=false;return;} // No buffer, no new frame.
    struct wl_shm_buffer *b=s->buffer ? wl_shm_buffer_get(s->buffer) : NULL;
    if(!s->acknowledged || s->configured!=s->acknowledged || !b || !s->callback || !mirror_commit(s,b)) {
        fail(s,"expected an acknowledged and valid SHM commit");
        return;
    }
    wl_callback_send_done(s->callback,s->frames);
    wl_resource_destroy(s->callback); s->callback=NULL;
    // Compare the live server resource, not an ID/address that could have been
    // recycled after destroy. Observing it does not extend its lifetime.
    bool reused=s->last_buffer==s->buffer;
    if(!reused) {
        if(s->last_buffer) wl_list_remove(&s->last_buffer_gone.link);
        s->last_buffer=s->buffer;
        wl_resource_add_destroy_listener(s->last_buffer,&s->last_buffer_gone);
    }
    wl_buffer_send_release(s->buffer); s->buffer=NULL;
    printf("WAYLAND_RELEASE seq=%u buffer=%s\n",s->frames,reused ? "reused" : "new");
    if(fflush(stdout)!=0) fail(s,"cannot write buffer release witness");
    s->damage_height=s->damage_width=0;
    if(!s->input) {
        s->input=wl_event_loop_add_fd(wl_display_get_event_loop(s->display),STDIN_FILENO,WL_EVENT_READABLE,input_ready,s);
        if(!s->input) fail(s,"could not own fixture input channel");
    }
}
static const struct wl_surface_interface surface_impl={.destroy=destroy,.attach=attach,.damage=damage,.frame=frame,.commit=commit,.set_opaque_region=opaque_hint};
static void surface_gone(struct wl_resource *r) {
    struct Server *s=wl_resource_get_user_data(r); s->surface=NULL; s->pointer_entered=false;
}
static void create_surface(struct wl_client *c, struct wl_resource *r, uint32_t id) {
    struct Server *s=wl_resource_get_user_data(r);
    if(s->surface) {fail(s,"only one window is owned"); return;}
    s->surface=wl_resource_create(c,&wl_surface_interface,1,id);
    if(!s->surface){wl_client_post_no_memory(c);return;}
    wl_resource_set_implementation(s->surface,&surface_impl,s,surface_gone);
}
static void region_rect(struct wl_client *c, struct wl_resource *region, int32_t x, int32_t y, int32_t w, int32_t h) {
    (void)c;(void)region;(void)x;(void)y;(void)w;(void)h;
}
static const struct wl_region_interface region_impl={.destroy=destroy,.add=region_rect,.subtract=region_rect};
static void create_region(struct wl_client *c, struct wl_resource *compositor, uint32_t id) {
    (void)compositor;
    struct wl_resource *region=wl_resource_create(c,&wl_region_interface,1,id);
    if(region) wl_resource_set_implementation(region,&region_impl,NULL,NULL); else wl_client_post_no_memory(c);
}
static const struct wl_compositor_interface compositor={.create_surface=create_surface,.create_region=create_region};
static void bind_compositor(struct wl_client *c, void *data, uint32_t v, uint32_t id) {
    struct wl_resource *r=wl_resource_create(c,&wl_compositor_interface,(int)v,id);
    if(r)wl_resource_set_implementation(r,&compositor,data,NULL);else wl_client_post_no_memory(c);
}

static void window_label(struct wl_client *c, struct wl_resource *window, const char *label) {
    (void)c;(void)window;(void)label;
}
static void unconstrained_size(struct wl_client *c, struct wl_resource *window, int32_t w, int32_t h) {
    (void)c;
    if(w || h) fail(wl_resource_get_user_data(window),"fixture only supports unconstrained windows");
}
static const struct xdg_toplevel_interface top_impl={
    .destroy=destroy,.set_title=window_label,.set_app_id=window_label,
    .set_min_size=unconstrained_size,.set_max_size=unconstrained_size,
};
static void top_gone(struct wl_resource *r){((struct Server *)wl_resource_get_user_data(r))->window=NULL;}
static void top(struct wl_client *c, struct wl_resource *r, uint32_t id) {
    struct Server *s=wl_resource_get_user_data(r);
    if(s->window){fail(s,"duplicate toplevel");return;}
    s->window=wl_resource_create(c,&xdg_toplevel_interface,1,id);
    if(s->window)wl_resource_set_implementation(s->window,&top_impl,s,top_gone);else wl_client_post_no_memory(c);
}
static void ack(struct wl_client *c, struct wl_resource *r, uint32_t seq) {
    (void)c;
    struct Server *s=wl_resource_get_user_data(r);
    if(seq!=s->configured || seq==s->acknowledged){fail(s,"wrong configure acknowledgement");return;}
    s->acknowledged=seq;s->width=s->pending_width;s->height=s->pending_height;
}
static void window_geometry(struct wl_client *c, struct wl_resource *role, int32_t x, int32_t y, int32_t w, int32_t h) {
    (void)c;
    struct Server *s=wl_resource_get_user_data(role);
    if(x || y || w < 1 || w > MAX_W || h < 1 || h > MAX_H) fail(s,"invalid fixture window geometry");
}
static const struct xdg_surface_interface role_impl={
    .destroy=destroy,.get_toplevel=top,.ack_configure=ack,.set_window_geometry=window_geometry,
};
static void role_gone(struct wl_resource *r){((struct Server *)wl_resource_get_user_data(r))->role=NULL;}
static void role(struct wl_client *c, struct wl_resource *wm, uint32_t id, struct wl_resource *surf) {
    struct Server *s=wl_resource_get_user_data(wm);
    if(s->role || surf!=s->surface){fail(s,"wrong xdg surface");return;}
    s->role=wl_resource_create(c,&xdg_surface_interface,1,id);
    if(s->role)wl_resource_set_implementation(s->role,&role_impl,s,role_gone);else wl_client_post_no_memory(c);
}
static const struct xdg_wm_base_interface wm_impl={.destroy=destroy,.get_xdg_surface=role};
static void bind_wm(struct wl_client *c, void *data, uint32_t v, uint32_t id) {
    struct wl_resource *r=wl_resource_create(c,&xdg_wm_base_interface,(int)v,id);
    if(r)wl_resource_set_implementation(r,&wm_impl,data,NULL);else wl_client_post_no_memory(c);
}

#ifdef EVERYDAY_TEST_LAYER
static void output_gone(struct wl_resource *r) {
    ((struct Server *)wl_resource_get_user_data(r))->output=NULL;
}
static const struct wl_output_interface output_impl={.release=destroy};
static void bind_output(struct wl_client *c, void *data, uint32_t v, uint32_t id) {
    struct Server *s=data;
    if(s->output){fail(s,"only one output binding is owned");return;}
    s->output=wl_resource_create(c,&wl_output_interface,(int)v,id);
    if(!s->output){wl_client_post_no_memory(c);return;}
    wl_resource_set_implementation(s->output,&output_impl,s,output_gone);
    wl_output_send_geometry(s->output,0,0,180,120,WL_OUTPUT_SUBPIXEL_UNKNOWN,
                            "Ricebox","Fixture",WL_OUTPUT_TRANSFORM_NORMAL);
    wl_output_send_mode(s->output,WL_OUTPUT_MODE_CURRENT|WL_OUTPUT_MODE_PREFERRED,MAX_W,MAX_H,60000);
    if(v >= 2){wl_output_send_scale(s->output,1); wl_output_send_done(s->output);}
}
static void layer_gone(struct wl_resource *r){((struct Server *)wl_resource_get_user_data(r))->layer=NULL;}
static void layer_size(struct wl_client *c, struct wl_resource *r,uint32_t w,uint32_t h) {
    (void)c;
    if(w<1 || w>MAX_W || h<1 || h>MAX_H) fail(wl_resource_get_user_data(r),"invalid bounded layer size");
}
static void layer_anchor(struct wl_client *c, struct wl_resource *r,uint32_t anchor) {
    (void)c;
    struct Server *s=wl_resource_get_user_data(r);
    if(anchor != (ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP|ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT))
        fail(s,"wrong top-left layer anchors");
    s->anchor=anchor;
}
static void layer_margin(struct wl_client *c,struct wl_resource *r,int32_t t,int32_t right,int32_t b,int32_t left) {
    (void)c;
    if(t || right || b || left) fail(wl_resource_get_user_data(r),"unexpected layer margin");
}
static void layer_zone(struct wl_client *c,struct wl_resource *r,int32_t zone) {
    (void)c;
    if(zone) fail(wl_resource_get_user_data(r),"unexpected layer zone");
}
static void layer_keyboard(struct wl_client *c,struct wl_resource *r,uint32_t keyboard) {
    (void)c;
    if(keyboard) fail(wl_resource_get_user_data(r),"unexpected layer keyboard policy");
}
static void destroy_layer(struct wl_client *c,struct wl_resource *r) {
    struct Server *s=wl_resource_get_user_data(r);
    if(s->closing) puts("WAYLAND_LAYER_CLIENT_DESTROY");
    destroy(c,r);
}
static const struct zwlr_layer_surface_v1_interface layer_surface_impl={
    .set_size=layer_size,.set_anchor=layer_anchor,.set_exclusive_zone=layer_zone,.set_margin=layer_margin,
    .set_keyboard_interactivity=layer_keyboard,.ack_configure=ack,.destroy=destroy_layer,
};
static void layer_surface(struct wl_client *c,struct wl_resource *shell,uint32_t id,struct wl_resource *surface,
                          struct wl_resource *output,uint32_t layer,const char *scope) {
    struct Server *s=wl_resource_get_user_data(shell);
    if(s->layer || s->role || surface!=s->surface || !s->output || output!=s->output ||
       layer!=ZWLR_LAYER_SHELL_V1_LAYER_TOP || strcmp(scope,"ricebox-layer-proof")) {
        fail(s,"expected Qt layer over the fixture output");
        return;
    }
    s->layer=wl_resource_create(c,&zwlr_layer_surface_v1_interface,1,id);
    if(!s->layer){wl_client_post_no_memory(c);return;}
    wl_resource_set_implementation(s->layer,&layer_surface_impl,s,layer_gone);
}
static const struct zwlr_layer_shell_v1_interface layer_shell_impl={.get_layer_surface=layer_surface};
static void bind_layer_shell(struct wl_client *c,void *data,uint32_t v,uint32_t id) {
    struct wl_resource *r=wl_resource_create(c,&zwlr_layer_shell_v1_interface,(int)v,id);
    if(r)wl_resource_set_implementation(r,&layer_shell_impl,data,NULL);else wl_client_post_no_memory(c);
}

#endif

static void cursor(struct wl_client *c, struct wl_resource *r, uint32_t seq, struct wl_resource *s, int32_t x, int32_t y) {
    (void)c;(void)r;(void)seq;(void)s;(void)x;(void)y;
}
static const struct wl_pointer_interface ptr_impl={.set_cursor=cursor};
static void ptr_gone(struct wl_resource *r){((struct Server *)wl_resource_get_user_data(r))->pointer=NULL;}
static void pointer(struct wl_client *c, struct wl_resource *seat, uint32_t id) {
    struct Server *s=wl_resource_get_user_data(seat);
    if(s->pointer){fail(s,"duplicate seat pointer");return;}
    s->pointer=wl_resource_create(c,&wl_pointer_interface,1,id);
    if(s->pointer)wl_resource_set_implementation(s->pointer,&ptr_impl,s,ptr_gone);else wl_client_post_no_memory(c);
}
static const struct wl_seat_interface seat_impl={.get_pointer=pointer};
static void bind_seat(struct wl_client *c, void *data, uint32_t v, uint32_t id) {
    struct wl_resource *r=wl_resource_create(c,&wl_seat_interface,(int)v,id);
    if(r){wl_resource_set_implementation(r,&seat_impl,data,NULL);wl_seat_send_capabilities(r,WL_SEAT_CAPABILITY_POINTER);}
    else wl_client_post_no_memory(c);
}
static void disconnected(struct wl_listener *listener, void *data) {
    (void)data;
    struct Server *s=wl_container_of(listener,s,gone);s->client_gone=true;
}
int guest_wayland_server(int fd, const char *mirror) {
    struct Server s={.gone={.notify=disconnected},.last_buffer_gone={.notify=last_buffer_destroyed}};
    int n=snprintf(s.name,sizeof s.name,"%s/frame.rgba",mirror), m=snprintf(s.temporary,sizeof s.temporary,"%s/frame.new",mirror);
    if(n<0 || (size_t)n>=sizeof s.name || m<0 || (size_t)m>=sizeof s.temporary){close(fd);return 41;}
    s.display=wl_display_create();
    if(!s.display){close(fd);return 42;}
    bool globals=wl_display_init_shm(s.display)==0 &&
                 wl_global_create(s.display,&wl_compositor_interface,1,&s,bind_compositor) &&
                 wl_global_create(s.display,&xdg_wm_base_interface,1,&s,bind_wm) &&
                 wl_global_create(s.display,&wl_seat_interface,1,&s,bind_seat);
#ifdef EVERYDAY_TEST_LAYER
    globals=globals && wl_global_create(s.display,&wl_output_interface,2,&s,bind_output) &&
              wl_global_create(s.display,&zwlr_layer_shell_v1_interface,1,&s,bind_layer_shell);
#endif
    if(!globals){close(fd);wl_display_destroy(s.display);return 43;}
    s.client=wl_client_create(s.display,fd);
    if(!s.client){close(fd);wl_display_destroy(s.display);return 44;}
    wl_client_add_destroy_listener(s.client,&s.gone);
    struct wl_event_loop *ring=wl_display_get_event_loop(s.display);
    while(!s.client_gone && !s.failed){
        if(wl_event_loop_dispatch(ring,-1)<0){if(errno==EINTR)continue;fail(&s,"libwayland dispatch failed");break;}
        wl_display_flush_clients(s.display);
    }
    if(s.input)wl_event_source_remove(s.input);
    if(!s.client_gone)wl_client_destroy(s.client);
    wl_display_destroy(s.display);
    return s.failed || !s.frames || !s.closing ? 45 : 0;
}
