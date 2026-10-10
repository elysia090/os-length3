# Network boundary

## Execution profiles

The Linux network stack is shared; only its device adapter differs. Native
execution may attach the optimized kernel to a physical NIC or an ordinary
TAP/virtio device and use the host's native scheduling and buffer management.
Browser execution attaches the same machine ABI to a virtual NIC backed by
WebTransport. DNS, sockets, TCP, UDP, congestion control, TLS, and certificate
validation are never reimplemented by either delivery layer.

## Invariant

The guest sees one ordinary virtio network device. Linux owns Ethernet, ARP,
IPv4, IPv6, routing, DNS, sockets, TCP, UDP, congestion control, and TLS. The
browser does not mirror those tables and the gateway does not terminate guest
TCP or TLS connections.

The only host-visible operation is a bounded network poll:

```text
network_poll(generation, poll, transmitted_frames)
    -> (link_state, received_frames)
```

Each frame is one complete Ethernet frame. Keeping the device boundary at
Ethernet avoids a second ARP or IPv6-neighbour implementation in the browser.
The gateway can bridge the frames to an IP tunnel and discard the link header.
If a fixed peer makes that header redundant, QM may store it once as a shared
projection; this does not change the device semantics.

The x86 machine reaches `network_poll` only after it has consumed available RX
buffers or produced a bounded TX batch. The event is a barrier. Everything
between two such events is deterministic VM work and remains eligible for
state-step closure, replay, and quotient minimization.

## Browser transport

The browser opens one WebTransport session to an origin-authorized gateway.
Ethernet frames use WebTransport datagrams. Loss and reordering remain visible
to Linux; the browser does not add another acknowledgement or retransmission
scheme over TCP and QUIC.

Admission requires an actual datagram-capable session, not just the existence
of `WebTransport`. Reject reliable-only negotiation, absent datagrams or an
an unusable maximum datagram size as unavailable networking. Do not quietly
substitute reliable streams or fetch for the NIC. This does not block offline
shell readiness.

A single reliable bidirectional stream carries only control records:

```text
hello(version, session, generation)
link(generation, up, mtu, guest_mac, gateway_mac)
address(generation, address, prefix)
route(generation, prefix, next_hop)
dns(generation, addresses)
credit(generation, receive_frames, receive_bytes)
close(generation, reason)
```

Do not derive guest MTU by blindly subtracting a transport header from the
datagram limit. IPv6 requires a link MTU of at least 1280; a smaller carrier
requires fragmentation/reassembly below IPv6. Ethernet and bridge headers also
consume bytes. The guest link keeps its declared Linux MTU (initial target:
1500), while the bridge fragments an opaque Ethernet frame when necessary.
This is not IP fragmentation, a socket implementation or a reliable tunnel.
The gateway still returns ordinary ICMP packet-too-big for a smaller *onward*
IP path.

The bridge protocol uses one fixed 32-byte little-endian
header, including on single-fragment frames:

```
version:u32 | frame_extent:u32 | generation:u64 | frame_rank:u64
fragment_rank:u32 | fragment_stride:u32
```

For admitted datagram budget `D > 32`, stride `P = D - 32`, frame extent `F`,
fragment `i` has exactly the bytes `[i*P, min(F,(i+1)*P))`. The receiver checks
the negotiated stride, nonzero bounded `F`, rank `< ceil(F/P)` and that exact
payload extent **before** copying. One bounded arena reservation and presence
bitmap hold a frame; no packet-sized prefix scan, file hash or second buffer
per fragment is required. Bound pending frame count, fragment count, bytes,
rate and lifetime. Discard incomplete/expired/invalid frames, duplicate parts
never advance completion twice, and admit a complete frame only once. Loss
remains normal link packet loss; the bridge does not retransmit or ACK fragments.
The frame rank is only a reassembly coordinate, not a TCP/QUIC reliability
sequence. It cannot wrap under the same session/generation. Raw peer traffic
remains untrusted input, and this design is not yet an implemented NIC.

The WebTransport session already preserves datagram boundaries and QUIC
authenticates its records. Authority scope and grant revision are immutable
session bindings outside this header: queued/callback records retain their
captured binding rather than acquiring the latest grant at delivery time.
Regrant opens a newly authorized session. Trace order is recorded at
`network_poll`; reliable control records are not a second packet transport.

The WebTransport connection lives outside the disposable VM worker. Restarting
the VM publishes a new generation before any frame is admitted. Frames and
control records from an older generation are discarded. A bounded ingress
queue may survive a worker restart, but Linux RAM and virtqueues do not. The
initial recovery contract is therefore an ordinary link down/up transition;
survival of established TCP connections is not claimed.

## Gateway

The browser API establishes WebTransport, not a generic `CONNECT-IP` Extended
CONNECT request. The browser-facing protocol therefore uses its own versioned
WebTransport session. The gateway maps its datagrams and reliable control
records to CONNECT-IP packet and capsule semantics and may speak actual
CONNECT-IP on an upstream hop.

The gateway is allowed to observe and route packet metadata but is not a trust
anchor for guest applications. HTTPS and SSH remain end-to-end from Linux. The
gateway must authenticate the browser origin and session, constrain source
addresses and advertised routes, reject spoofed frames, bound queues and rates,
and deny private-network reachability unless it is explicitly granted.

## Physical state

RX and TX descriptor rings are guest RAM and therefore use the same canonical
dirty-page representation as the rest of the machine. Host transport state is
only:

```text
(session, generation, link configuration,
 bounded ingress frames, bounded egress frames)
```

It is not part of the filesystem root and is never placed in the immutable
machine artifact. A replay supplies the recorded link records and ingress
frames at the same barrier coordinates and suppresses real egress. A live run
acknowledges a TX descriptor only after the frame has either entered the
bounded WebTransport send queue or been deliberately dropped by the declared
queue policy.

## Workspace connections and ingress

The product model is the workspace connection defined in
[BROWSER.md](BROWSER.md), not a list of emulated PC hardware. A network grant
binds workspace, authority scope, resource/lane, machine generation, grant revision,
gateway policy, direction, routes, expiry and byte/queue budgets. The C resource
gate fences operation completions; the gateway independently enforces origin,
session and route policy. Revoke stops new admissions and closes the connection,
but cannot unsend a frame already delivered to an external peer.

A development server needs a separate **publish** grant for one guest port and
its ingress audience. The packet gateway can route/NAT that ingress through
the same NIC; it does not expose all ports or add host reachability by default.
Return an actual usable browser endpoint, not a guest-local IP that the browser
cannot route. A guest TLS endpoint keeps its TLS keys/certificate semantics in
Linux. If HTTPS preview of a plain HTTP server requires an external application
proxy, it is a distinct, declared service with its own TLS termination and
audience policy, not a change to the packet gateway invariant or a silent
guest socket fallback. Test expiry/revocation and cross-workspace access.

The browser transport broker may outlive the CPU Worker. This does not entitle
old network replies to mutate a replacement machine; generation and grant
revision are checked before RX admission. Live link recovery still follows the
declared link-down/up contract unless a full network/device suspend cut has
been proved. No browser or Service Worker API promises immortal TCP sessions.

## Implementation order

The [local packet gateway](../network/gateway/README.md) now implements the
bounded fragment protocol, real WebTransport datagrams and explicit pinned
loopback admission. Its actual-browser1514-byte reverse/duplicate-fragment
roundtrip passes. Its diagnostic echo is not Internet connectivity, and its
Linux TAP backend requires a separately authorized interface/route policy.
The C VM NIC and complete guest network connection remain unimplemented;
the following end-to-end gates are not replaced by the transport receipt.

1. Enable the upstream Linux network stack and `virtio-mmio`/`virtio-net`
   drivers without patching kernel networking code.
2. Add the standard virtio MMIO register page, one RX queue, one TX queue, and
   one interrupt to the x86 machine.
3. Publish bounded TX/RX batches through the C machine ABI and `vm.wasm` to
   the browser host transport; no Python/JS instruction or socket fallback.
4. Add the bounded C frame bridge, WebTransport adapter and gateway, then prove
   ICMP, DNS, HTTPS, Git, IPv4/IPv6 with a datagram budget smaller than 1280,
   duplicate/reordered/missing fragments, MTU reduction, worker restart and
   deterministic replay. Resource-gate unit success cannot pass this gate.

## Standards

- OASIS, *Virtual I/O Device (VIRTIO) Version 1.3*, sections 4.2 and 5.1.
- RFC 9221, *An Unreliable Datagram Extension to QUIC*.
- RFC 9297, *HTTP Datagrams and the Capsule Protocol*.
- RFC 9484, *Proxying IP in HTTP*.
- [RFC 8200 section 5](https://www.rfc-editor.org/rfc/rfc8200.html#section-5), IPv6 minimum link MTU and below-IP fragmentation.
- [WebTransport maximum datagram size](https://developer.mozilla.org/en-US/docs/Web/API/WebTransportDatagramDuplexStream/maxDatagramSize).
- W3C, *WebTransport*, Working Draft.
