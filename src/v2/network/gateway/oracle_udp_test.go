package main

import (
	"context"
	"net"
	"net/http"
	"os"
	"sync/atomic"
	"testing"
	"time"
)

func TestExplicitHostHTTPS(t *testing.T) {
	if os.Getenv("LENGTH3_TEST_HOST_TLS") != "1" {
		t.Skip("explicit public host reachability probe required")
	}
	client := http.Client{Timeout: 10 * time.Second}
	if address := os.Getenv("LENGTH3_TEST_HOST_IPV4"); address != "" {
		ip := net.ParseIP(address)
		if ip == nil || ip.To4() == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() {
			t.Fatal("explicit public IPv4")
		}
		client.Transport = &http.Transport{DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, net.JoinHostPort(address, "443"))
		}}
	}
	reply, err := client.Get("https://example.com")
	if err != nil {
		t.Fatal(err)
	}
	defer reply.Body.Close()
	if reply.StatusCode != 200 || reply.TLS == nil || len(reply.TLS.VerifiedChains) == 0 {
		t.Fatal("verified host HTTPS")
	}
	t.Log("host TCP/TLS and certificate validation reached HTTP 200; not guest acceptance")
}

// Test-only Ethernet carrier for an independent QEMU CPU oracle. Reuses the
// exact packet backend; no guest CPU, Linux socket or DNS code exists here.
func TestOraclePacketUDP(t *testing.T) {
	local, peer := os.Getenv("LENGTH3_ORACLE_UDP_LOCAL"), os.Getenv("LENGTH3_ORACLE_UDP_PEER")
	if local == "" && peer == "" {
		t.Skip("explicit loopback oracle carrier required")
	}
	for _, address := range []string{local, peer} {
		if err := localAddress(address); err != nil {
			t.Fatal(err)
		}
	}
	to, err := net.ResolveUDPAddr("udp4", peer)
	if err != nil {
		t.Fatal(err)
	}
	from, err := net.ResolveUDPAddr("udp4", local)
	if err != nil {
		t.Fatal(err)
	}
	socket, err := net.ListenUDP("udp4", from)
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	link, err := openUserNetwork(os.Getenv("LENGTH3_TEST_SLIRP_DLL"), os.Getenv("LENGTH3_TEST_SLIRP_SHA256"))
	if err != nil {
		t.Fatal(err)
	}
	defer link.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	received := make(chan error, 1)
	var incoming, outgoing atomic.Uint64
	go func() {
		buffer := make([]byte, 2049)
		var total uint64
		for {
			socket.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
			n, address, e := socket.ReadFromUDP(buffer)
			if e != nil {
				if ctx.Err() != nil {
					received <- nil
					return
				}
				if timeout, ok := e.(net.Error); ok && timeout.Timeout() {
					continue
				}
				received <- e
				return
			}
			if !address.IP.Equal(to.IP) || address.Port != to.Port || n < 14 || n > 2048 {
				continue
			}
			rank := incoming.Add(1)
			if os.Getenv("LENGTH3_ORACLE_FRAME_LOG") == "1" && rank <= 32 {
				limit := n
				if limit > 80 {
					limit = 80
				}
				t.Logf("oracle frame in %d/%d: %x", rank, n, buffer[:limit])
			}
			total += uint64(n)
			if total > 64<<20 {
				received <- errFrame
				return
			}
			if e = link.WriteFrame(buffer[:n]); e != nil {
				received <- e
				return
			}
		}
	}()
	t.Logf("independent oracle Ethernet carrier ready: %s -> %s", local, peer)
	buffer := make([]byte, 2048)
	for ctx.Err() == nil {
		n, e := link.ReadFrame(ctx, buffer)
		if e != nil {
			if ctx.Err() == nil {
				t.Error(e)
			}
			break
		}
		if _, e = socket.WriteToUDP(buffer[:n], to); e != nil {
			t.Error(e)
			break
		}
		rank := outgoing.Add(1)
		if os.Getenv("LENGTH3_ORACLE_FRAME_LOG") == "1" && rank <= 32 {
			limit := n
			if limit > 80 {
				limit = 80
			}
			t.Logf("oracle frame out %d/%d: %x", rank, n, buffer[:limit])
		}
	}
	cancel()
	socket.Close()
	if e := <-received; e != nil {
		t.Error(e)
	}
	t.Logf("oracle carrier: %d incoming, %d outgoing", incoming.Load(), outgoing.Load())
}
