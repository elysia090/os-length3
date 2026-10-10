package main

import (
	"bytes"
	"encoding/binary"
	"testing"
	"time"
)

func packets(t *testing.T, frame []byte, generation, rank uint64, stride uint32) [][]byte {
	t.Helper()
	var p [][]byte
	if err := fragments(frame, generation, rank, stride, func(b []byte) error { p = append(p, b); return nil }); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestAllGeometry(t *testing.T) {
	now := time.Now()
	for stride := uint32(32); stride <= 1100; stride += 17 {
		for n := 14; n <= maximumFrame; n += 13 {
			frame := make([]byte, n)
			for i := range frame {
				frame[i] = byte(i*31 + n)
			}
			w := frameWindow{generation: 7, stride: stride}
			p := packets(t, frame, 7, 1, stride)
			var result []byte
			for i := len(p) - 1; i >= 0; i-- {
				b, err := w.accept(p[i], now)
				if err != nil {
					t.Fatal(err)
				}
				if b != nil {
					result = b
				} else {
					if b, err := w.accept(p[i], now); err != nil || b != nil {
						t.Fatal("duplicate advanced completion")
					}
				}
			}
			if !bytes.Equal(result, frame) {
				t.Fatal("roundtrip")
			}
			for _, b := range p {
				if _, err := w.accept(b, now); err == nil {
					t.Fatal("completed frame replay")
				}
			}
		}
	}
}

func TestRejectAndLifetime(t *testing.T) {
	now := time.Now()
	frame := make([]byte, 1514)
	p := packets(t, frame, 2, 1, 500)
	for offset := 0; offset < 32; offset++ {
		w := frameWindow{generation: 2, stride: 500}
		bad := bytes.Clone(p[0])
		bad[offset] ^= 128
		// A changed rank or bounded total extent is valid in isolation.
		// The first non-final fragment cannot know the final frame extent.
		if offset == 4 || offset >= 16 && offset < 24 {
			continue
		}
		if _, err := w.accept(bad, now); err == nil {
			t.Fatalf("accepted bad field %d", offset)
		}
	}
	for _, size := range []uint32{0, 13, maximumFrame + 1, ^uint32(0)} {
		w := frameWindow{generation: 2, stride: 500}
		bad := bytes.Clone(p[0])
		binary.LittleEndian.PutUint32(bad[4:], size)
		if _, err := w.accept(bad, now); err == nil {
			t.Fatal("invalid extent")
		}
	}
	w := frameWindow{generation: 2, stride: 500}
	if _, err := w.accept(p[0], now); err != nil {
		t.Fatal(err)
	}
	bad := bytes.Clone(p[0])
	bad[32] ^= 1
	if _, err := w.accept(bad, now); err == nil {
		t.Fatal("conflicting duplicate")
	}
	for _, b := range p {
		if _, err := w.accept(b, now); err == nil {
			t.Fatal("poisoned frame")
		}
	}
	w = frameWindow{generation: 2, stride: 500}
	w.accept(p[0], now)
	if _, err := w.accept(p[1], now.Add(3*time.Second)); err == nil {
		t.Fatal("expired frame")
	}
	w = frameWindow{generation: 2, stride: 500}
	for rank := uint64(2); rank <= 66; rank++ {
		b := packets(t, frame, 2, rank, 500)[0]
		w.accept(b, now)
	}
	if _, err := w.accept(p[0], now); err == nil {
		t.Fatal("old rank outside window")
	}
	bad = bytes.Clone(p[0])
	binary.LittleEndian.PutUint32(bad[24:], 3)
	if _, err := w.accept(bad, now); err == nil {
		t.Fatal("part overflow")
	}
}

func FuzzFragment(f *testing.F) {
	f.Add(make([]byte, 33))
	f.Add(make([]byte, 2048))
	for _, size := range []int{14, 1068, 1514, 2048} {
		frame := make([]byte, size)
		fragments(frame, 1, 1, 1068, func(b []byte) error { f.Add(b); return nil })
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		w := frameWindow{generation: 1, stride: 1068}
		now := time.Now()
		frame, _ := w.accept(b, now)
		if frame != nil {
			if second, err := w.accept(b, now); err == nil || second != nil {
				t.Fatal("completed identity replay")
			}
		}
		w.accept(b, now.Add(3*time.Second))
		for _, row := range w.rows {
			if len(row.data) > maximumFrame {
				t.Fatal("unbounded resident row")
			}
		}
	})
}
