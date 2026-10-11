//go:build windows && cgo

package main

import (
	"context"
	"encoding/binary"
	"os"
	"testing"
	"time"
)

func TestPinnedPacketNAT(t *testing.T) {
	file := os.Getenv("LENGTH3_TEST_SLIRP_DLL")
	if file == "" {
		t.Skip("explicit official packet DLL required")
	}
	link, err := openUserNetwork(file, os.Getenv("LENGTH3_TEST_SLIRP_SHA256"))
	if err != nil {
		t.Fatal(err)
	}
	defer link.Close()
	frame := make([]byte, 42)
	for i := 0; i < 6; i++ {
		frame[i] = 255
	}
	mac := []byte{2, 0x6c, 0x33, 0, 0, 1}
	copy(frame[6:12], mac)
	binary.BigEndian.PutUint16(frame[12:14], 0x0806)
	binary.BigEndian.PutUint16(frame[14:16], 1)
	binary.BigEndian.PutUint16(frame[16:18], 0x0800)
	frame[18] = 6
	frame[19] = 4
	binary.BigEndian.PutUint16(frame[20:22], 1)
	copy(frame[22:28], mac)
	copy(frame[28:32], []byte{10, 0, 2, 15})
	copy(frame[38:42], []byte{10, 0, 2, 2})
	if err = link.WriteFrame(frame); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	out := make([]byte, 2048)
	n, err := link.ReadFrame(ctx, out)
	if err != nil {
		t.Fatal(err)
	}
	if n < 42 || binary.BigEndian.Uint16(out[20:22]) != 2 || out[28] != 10 || out[31] != 2 {
		t.Fatalf("actual libslirp ARP response: %x", out[:n])
	}
}

// Explicit integration probe: a real upstream DNS response, not an echo or
// a browser-side resolver. This is outside the deterministic unit gate.
func TestPinnedPacketNATDNS(t *testing.T) {
	if os.Getenv("LENGTH3_TEST_SLIRP_DNS") != "1" {
		t.Skip("explicit upstream DNS probe required")
	}
	link, err := openUserNetwork(os.Getenv("LENGTH3_TEST_SLIRP_DLL"), os.Getenv("LENGTH3_TEST_SLIRP_SHA256"))
	if err != nil {
		t.Fatal(err)
	}
	defer link.Close()
	query := []byte{0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 7, 'e', 'x', 'a', 'm', 'p', 'l', 'e', 3, 'c', 'o', 'm', 0, 0, 1, 0, 1}
	frame := make([]byte, 14+20+8+len(query))
	copy(frame[:6], []byte{0x52, 0x55, 10, 0, 2, 3})
	copy(frame[6:12], []byte{2, 0x6c, 0x33, 0, 0, 1})
	binary.BigEndian.PutUint16(frame[12:14], 0x0800)
	ip := frame[14:34]
	ip[0] = 0x45
	ip[8] = 64
	ip[9] = 17
	binary.BigEndian.PutUint16(ip[2:4], uint16(len(frame)-14))
	copy(ip[12:16], []byte{10, 0, 2, 15})
	copy(ip[16:20], []byte{10, 0, 2, 3})
	var checksum uint32
	for n := 0; n < 20; n += 2 {
		checksum += uint32(binary.BigEndian.Uint16(ip[n : n+2]))
	}
	for checksum>>16 != 0 {
		checksum = (checksum & 65535) + (checksum >> 16)
	}
	binary.BigEndian.PutUint16(ip[10:12], ^uint16(checksum))
	udp := frame[34:42]
	binary.BigEndian.PutUint16(udp[:2], 40123)
	binary.BigEndian.PutUint16(udp[2:4], 53)
	binary.BigEndian.PutUint16(udp[4:6], uint16(8+len(query)))
	copy(frame[42:], query)
	if err = link.WriteFrame(frame); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out := make([]byte, 2048)
	for {
		n, e := link.ReadFrame(ctx, out)
		if e != nil {
			t.Fatal(e)
		}
		if n >= 42 && binary.BigEndian.Uint16(out[12:14]) == 0x0806 && binary.BigEndian.Uint16(out[20:22]) == 1 {
			// Supply the test guest's ordinary ARP response to the NAT.
			answer := append([]byte(nil), out[:42]...)
			copy(answer[:6], out[6:12])
			copy(answer[6:12], frame[6:12])
			binary.BigEndian.PutUint16(answer[20:22], 2)
			copy(answer[32:42], out[22:32])
			copy(answer[22:28], frame[6:12])
			copy(answer[28:32], ip[12:16])
			if e = link.WriteFrame(answer); e != nil {
				t.Fatal(e)
			}
			continue
		}
		if n >= 54 && binary.BigEndian.Uint16(out[12:14]) == 0x0800 && out[23] == 17 && binary.BigEndian.Uint16(out[36:38]) == 40123 {
			if binary.BigEndian.Uint16(out[42:44]) != 0x1234 || out[44]&0x80 == 0 {
				t.Fatal("DNS response identity")
			}
			t.Logf("real upstream DNS response: %d bytes, rcode=%d", n, out[45]&15)
			return
		}
	}
}
