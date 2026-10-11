//go:build windows && cgo

/* Host NAT adapter only. Do not decode guest instructions or terminate TLS.
 * Full-width socket API is mandatory; no deprecated int-fd fallback. */
#include "slirp_windows.h"
#define FD_SETSIZE 256
#include <libslirp.h>
#include <stdlib.h>
#include <string.h>
#define FRAMES 64u
#define FRAME_BYTES 2048u
#define SOCKETS 256u
typedef struct {SlirpTimerCb callback;void *owner;int64_t expiry;int active;} nat_timer;
typedef struct {slirp_os_socket socket;int events,revents;} socket_poll;
struct packet_nat {
    HMODULE library;Slirp *slirp;SlirpCb callbacks;
    Slirp *(*create)(const SlirpConfig *,const SlirpCb *,void *);
    void (*destroy)(Slirp *);
    void (*input)(Slirp *,const uint8_t *,int);
    void (*fill)(Slirp *,uint32_t *,SlirpAddPollSocketCb,void *);
    void (*poll)(Slirp *,int,SlirpGetREventsCb,void *);
    const char *(*version)(void);
    socket_poll sockets[SOCKETS];unsigned socket_count;
    uint8_t frame[FRAMES][FRAME_BYTES];unsigned length[FRAMES],head,count;
    nat_timer timers[8];
};
static int64_t now_ns(void *opaque){(void)opaque;LARGE_INTEGER ticks,frequency;QueryPerformanceCounter(&ticks);QueryPerformanceFrequency(&frequency);
    return ticks.QuadPart/frequency.QuadPart*1000000000ll+ticks.QuadPart%frequency.QuadPart*1000000000ll/frequency.QuadPart;}
static slirp_ssize_t send_packet(const void *bytes,size_t length,void *opaque){packet_nat *p=opaque;
    if(length<14u||length>FRAME_BYTES||p->count==FRAMES)return (slirp_ssize_t)length;
    unsigned slot=(p->head+p->count)%FRAMES;memcpy(p->frame[slot],bytes,length);p->length[slot]=(unsigned)length;++p->count;return (slirp_ssize_t)length;}
static void guest_error(const char *text,void *opaque){(void)text;(void)opaque;}
static void notify(void *opaque){(void)opaque;}
static void socket_notice(slirp_os_socket socket,void *opaque){(void)socket;(void)opaque;}
static void *timer_new(SlirpTimerCb cb,void *owner,void *opaque){packet_nat *p=opaque;for(unsigned i=0;i<8u;++i)if(!p->timers[i].active){p->timers[i]=(nat_timer){cb,owner,INT64_MAX,1};return p->timers+i;}return NULL;}
static void timer_free(void *timer,void *opaque){(void)opaque;((nat_timer *)timer)->active=0;}
static void timer_mod(void *timer,int64_t expiry,void *opaque){(void)opaque;((nat_timer *)timer)->expiry=expiry;}
static int add_socket(slirp_os_socket socket,int events,void *opaque){packet_nat *p=opaque;if(p->socket_count==SOCKETS)return -1;
    unsigned at=p->socket_count++;p->sockets[at]=(socket_poll){socket,events,0};return (int)at;}
static int revents(int at,void *opaque){packet_nat *p=opaque;if(at<0||(unsigned)at>=p->socket_count)return SLIRP_POLL_ERR;
    return p->sockets[at].revents;}
static int poll_sockets(packet_nat *p,uint32_t timeout)
{
    fd_set reads,writes,exceptions;FD_ZERO(&reads);FD_ZERO(&writes);FD_ZERO(&exceptions);
    _Static_assert(FD_SETSIZE>=SOCKETS,"full-width bounded Winsock sets");
    for(unsigned i=0u;i<p->socket_count;++i){const socket_poll *s=p->sockets+i;
        if(s->events&SLIRP_POLL_IN)FD_SET(s->socket,&reads);
        if(s->events&SLIRP_POLL_OUT)FD_SET(s->socket,&writes);
        if(s->events&(SLIRP_POLL_PRI|SLIRP_POLL_ERR))FD_SET(s->socket,&exceptions);}
    struct timeval wait={(long)(timeout/1000u),(long)((timeout%1000u)*1000u)};
    /* Winsock select ignores nfds and keeps complete SOCKET handles. A
     * connected read/EOF and a pending-connect write are different events;
     * no deprecated int-descriptor API or guest protocol enters this owner. */
    int result=select(0,&reads,&writes,&exceptions,&wait);
    if(result<0)return result;
    for(unsigned i=0u;i<p->socket_count;++i){socket_poll *s=p->sockets+i;
        if(FD_ISSET(s->socket,&reads))s->revents|=SLIRP_POLL_IN;
        if(FD_ISSET(s->socket,&writes))s->revents|=SLIRP_POLL_OUT;
        if(FD_ISSET(s->socket,&exceptions))s->revents|=(s->events&SLIRP_POLL_PRI)?SLIRP_POLL_PRI:SLIRP_POLL_ERR;}
    return result;
}
#define RESOLVE(field,name) do{FARPROC function=GetProcAddress(p->library,name);if(!function)goto failed;_Static_assert(sizeof p->field==sizeof function,"Windows function pointer width");memcpy(&p->field,&function,sizeof function);}while(0)
packet_nat *packet_nat_open(const uint16_t *path){WSADATA winsock;if(WSAStartup(MAKEWORD(2,2),&winsock))return NULL;
    packet_nat *p=calloc(1,sizeof *p);if(!p){WSACleanup();return NULL;}
    p->library=LoadLibraryExW((const WCHAR *)path,NULL,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);if(!p->library)goto failed;
    RESOLVE(create,"slirp_new");RESOLVE(destroy,"slirp_cleanup");RESOLVE(input,"slirp_input");RESOLVE(fill,"slirp_pollfds_fill_socket");RESOLVE(poll,"slirp_pollfds_poll");RESOLVE(version,"slirp_version_string");
    p->callbacks=(SlirpCb){.send_packet=send_packet,.guest_error=guest_error,.clock_get_ns=now_ns,.timer_new=timer_new,.timer_free=timer_free,.timer_mod=timer_mod,.notify=notify,.register_poll_socket=socket_notice,.unregister_poll_socket=socket_notice};
    SlirpConfig config={.version=6,.in_enabled=true,.if_mtu=1500,.if_mru=1500,.disable_host_loopback=true,.enable_emu=false};
    config.vnetwork.s_addr=htonl(0x0a000200u);config.vnetmask.s_addr=htonl(0xffffff00u);config.vhost.s_addr=htonl(0x0a000202u);
    config.vdhcp_start.s_addr=htonl(0x0a00020fu);config.vnameserver.s_addr=htonl(0x0a000203u);
    p->slirp=p->create(&config,&p->callbacks,p);if(!p->slirp)goto failed;return p;
failed: if(p->library)FreeLibrary(p->library);free(p);WSACleanup();return NULL;}
int packet_nat_input(packet_nat *p,const uint8_t *bytes,int length){if(!p||!bytes||length<14||length>(int)FRAME_BYTES)return -1;p->input(p->slirp,bytes,length);return 0;}
int packet_nat_read(packet_nat *p,uint8_t *out,int capacity){if(!p||!out||capacity<(int)FRAME_BYTES)return -1;
    if(!p->count){uint32_t timeout=10u;p->socket_count=0u;p->fill(p->slirp,&timeout,add_socket,p);
        int ready=p->socket_count?poll_sockets(p,timeout):0;if(!p->socket_count)Sleep(timeout);
        p->poll(p->slirp,ready<0,revents,p);int64_t time=now_ns(NULL)/1000000ll;
        for(unsigned i=0;i<8u;++i){nat_timer *t=p->timers+i;if(t->active&&t->expiry<=time){t->expiry=INT64_MAX;t->callback(t->owner);}}
    }
    if(!p->count)return 0;
    unsigned length=p->length[p->head];memcpy(out,p->frame[p->head],length);p->head=(p->head+1u)%FRAMES;--p->count;return (int)length;}
const char *packet_nat_version(packet_nat *p){return p?p->version():NULL;}
void packet_nat_close(packet_nat *p){if(!p)return;p->destroy(p->slirp);FreeLibrary(p->library);memset(p,0,sizeof *p);free(p);WSACleanup();}
