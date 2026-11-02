# libevent: the event loop tmux is written on; its core and extra libraries, headers and pkg-config files. Its TLS
# part is left out (nothing in the root speaks TLS through it), as are its samples, tests and debug mode, and its
# RPC generator, a Python script (the root has no Python).
pins="LIBEVENT"
build() {
  ./configure --prefix=/usr --disable-shared --enable-static --disable-openssl --disable-samples \
    --disable-libevent-regress --disable-debug-mode
  make -j"$jobs"
  make DESTDIR="$dest" install
  rm "$dest/usr/bin/event_rpcgen.py"
  rmdir "$dest/usr/bin"
}
check() {
  # A timer set on its loop fires.
  printf '%s\n' '#include <event2/event.h>' \
    'static void fire(evutil_socket_t s, short e, void *a) { (void)s; (void)e; *(int *)a = 1; }' \
    'int main(void) { int fired = 0; struct event_base *b = event_base_new(); struct timeval t = {0, 1000};' \
    '  struct event *ev = evtimer_new(b, fire, &fired); evtimer_add(ev, &t); event_base_dispatch(b); return !fired; }' > e.c
  gcc -static -I"$dest/usr/include" -o e e.c -L"$dest/usr/lib" -levent_core && ./e
}
