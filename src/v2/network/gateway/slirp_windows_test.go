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
