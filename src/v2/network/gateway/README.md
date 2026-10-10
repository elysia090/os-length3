# Local packet gateway

This gateway carries opaque Ethernet frames over WebTransport datagrams.
It terminates QUIC, not guest TCP or TLS. Linux remains the network-stack
authority. The portable diagnostic backend echoes a frame and does not offer
Internet connectivity. The Linux backend accepts an already authorized TAP
descriptor; it creates no interface, route, firewall rule or privilege grant.

## Build and verify

The independent gateway uses Go 1.26 or later and the exact dependencies in
`go.mod` and `go.sum`. Neither Go nor the gateway is part of the guest root.

```sh
cd src/v2/network/gateway
go test ./...
go test -fuzz=FuzzFragment -fuzztime=20s ./...
go build -o gateway .
./gateway -diagnostic-echo
```

Open `http://127.0.0.1:8084/probe` and press **Verify transport**. The probe
uses a CSPRNG-generated ECDSA certificate and its explicit SHA256 pin; it
does not disable certificate checking, modify a trust store or require
browser launch flags. The 14-day certificate limitation and datagram APIs
follow the [official WebTransport example](https://github.com/quic-go/webtransport-go/tree/v0.13.0/example)
and [Chrome WebTransport API](https://developer.chrome.com/docs/capabilities/web-apis/webtransport).

Linux deployment passes a TAP descriptor opened with `IFF_TAP|IFF_NO_PI`:

```sh
./gateway -tap-fd=3 -origin=http://127.0.0.1:8084
```

The process rejects a non-TAP descriptor. The broker/operator must separately
authorize and enforce the interface's address, source, route, ingress and
private-network policy. TAP adoption is not proof that public Internet access
is authorized or functional. Windows deliberately rejects the TAP mode.

## Authority and bounded state

Listeners bind explicit loopback IPs only. The HTTP control listener checks
its exact Host. WebTransport CONNECT requires the exact configured Origin and
a 256-bit random bearer capability. Only one session can own the link at once;
it expires after one hour and 64 MiB of received datagrams. The rate allowance
is 1 MiB plus 1 MiB per elapsed second. Public exposure and multi-workspace
authentication are not implemented by this local broker.

A reliable control stream exchanges only version, generation, fragment stride
and link metadata. Its initial record is limited to 1024 bytes and 5 seconds.
Generation is a decimal string in control JSON and an exact uint64 in the
binary header; JavaScript floating-point numbers never own that coordinate.
Ethernet payload never moves to a reliable stream or fetch fallback. Header
geometry is the 32-byte record defined in [NETWORK.md](../../docs/NETWORK.md).

For extent `F` and negotiated stride `P`, fragment `i` owns exactly
`[i*P,min(F,(i+1)*P))`. Validation precedes allocation/copy. One 64-frame reorder
window holds at most 128 KiB of payload, plus fixed descriptors. Frames expire
after 2 seconds. Completed, conflicting and expired identities retain a
tombstone until leaving the window. Duplicates cannot emit another frame.
Each session owns its generation and rank space; zero and wrapped ranks fail.
Incomplete frames are ordinary link loss, without retransmission or ACKs.

TAP polling is nonblocking and observes session cancellation within 100 ms.
The session joins its reader before releasing ownership, so a later session
cannot compete with an orphan reader for the same descriptor. TAP write
congestion is declared packet loss; partial writes fail the link.

## Verified scope

On 2026-10-10 the actual in-app browser exchanged one 1514-byte Ethernet frame
using 2 WebTransport datagrams with 1068-byte stride, reverse ordering and a
duplicate fragment. Certificate pinning and payload equality passed. An
independent Go client/server test uses real loopback QUIC, a verified root
certificate and the same frame geometry. Boundary tests and 1,572,781 fuzz
executions passed. The Windows executable and Linux executable both compile.

This is transport acceptance, not guest NIC acceptance. The C VM still needs
the virtio-MMIO register/DMA/interrupt owner and its bounded network barrier.
Guest DNS, curl/Git HTTPS, IPv4/IPv6, revocation and service publication remain
end-to-end gates. A transport PASS cannot satisfy those gates or Linux boot.
