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

The negotiated guest MTU is no greater than the WebTransport maximum datagram
size minus the generation header. Tunnel fragmentation is not implemented.
The gateway must return the ordinary ICMP packet-too-big signal when its onward
path has a smaller MTU.

Every datagram starts with the negotiated fixed-width protocol version and a
64-bit generation, followed by exactly one Ethernet frame. The WebTransport
session already preserves datagram boundaries and QUIC authenticates the
record, so there is no length field, packet hash, or transport-level sequence
number. Trace order is recorded at `network_poll`; TCP and QUIC already own the
sequence spaces they require.

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

## Implementation order

1. Enable the upstream Linux network stack and `virtio-mmio`/`virtio-net`
   drivers without patching kernel networking code.
2. Add the standard virtio MMIO register page, one RX queue, one TX queue, and
   one interrupt to the x86 machine.
3. Publish bounded TX/RX batches through `network_poll` in Python, `vm.wasm`,
   and the browser with no interpreter fallback.
4. Add the WebTransport adapter and gateway, then prove ICMP, DNS, HTTPS, Git,
   packet loss, MTU reduction, worker restart, and deterministic replay.

## Standards

- OASIS, *Virtual I/O Device (VIRTIO) Version 1.3*, sections 4.2 and 5.1.
- RFC 9221, *An Unreliable Datagram Extension to QUIC*.
- RFC 9297, *HTTP Datagrams and the Capsule Protocol*.
- RFC 9484, *Proxying IP in HTTP*.
- W3C, *WebTransport*, Working Draft.
