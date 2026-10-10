package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"time"
)

const headerBytes = 32
const maximumFrame = 2048
const windowFrames = 64

var errFrame = errors.New("invalid or stale frame fragment")

type assembly struct {
	rank     uint64
	extent   uint32
	parts    uint64
	data     []byte
	expires  time.Time
	complete bool
}

// A session/generation owns a fixed reorder window, including completed and
// expired identities. Duplicates cannot resurrect a frame after completion.
// All callers serialize this owner; no packet, prefix or hostname hashes.
type frameWindow struct {
	generation uint64
	stride     uint32
	maximum    uint64
	rows       [windowFrames]assembly
}

func (w *frameWindow) accept(packet []byte, now time.Time) ([]byte, error) {
	if len(packet) <= headerBytes || w.generation == 0 || w.stride < 32 || w.stride > maximumFrame {
		return nil, errFrame
	}
	version := binary.LittleEndian.Uint32(packet)
	extent := binary.LittleEndian.Uint32(packet[4:])
	generation := binary.LittleEndian.Uint64(packet[8:])
	rank := binary.LittleEndian.Uint64(packet[16:])
	part := binary.LittleEndian.Uint32(packet[24:])
	stride := binary.LittleEndian.Uint32(packet[28:])
	if version != 1 || generation != w.generation || rank == 0 || extent < 14 || extent > maximumFrame || stride != w.stride {
		return nil, errFrame
	}
	count := (extent + stride - 1) / stride
	if part >= count {
		return nil, errFrame
	}
	first := part * stride
	length := extent - first
	if length > stride {
		length = stride
	}
	if len(packet) != headerBytes+int(length) {
		return nil, errFrame
	}
	if rank <= w.maximum && w.maximum-rank >= windowFrames {
		return nil, errFrame
	}
	if rank > w.maximum {
		// Evict expired or out-of-window owners even when their slot is not
		// reused immediately. Retained bytes are bounded by 64 * 2048.
		w.maximum = rank
		for i := range w.rows {
			r := &w.rows[i]
			if r.rank != 0 && (rank-r.rank >= windowFrames || !now.Before(r.expires)) {
				r.data = nil
				r.complete = true
			}
		}
	}
	r := &w.rows[rank%windowFrames]
	if r.rank != rank {
		*r = assembly{rank: rank, extent: extent, data: make([]byte, extent), expires: now.Add(2 * time.Second)}
	}
	if r.extent != extent || r.complete || !now.Before(r.expires) {
		r.data = nil
		r.complete = true
		return nil, errFrame
	}
	bit := uint64(1) << part
	if r.parts&bit != 0 {
		if !bytes.Equal(r.data[first:first+length], packet[headerBytes:]) {
			r.data = nil
			r.complete = true
			return nil, errFrame
		}
		return nil, nil
	}
	copy(r.data[first:first+length], packet[headerBytes:])
	r.parts |= bit
	if r.parts != (uint64(1)<<count)-1 {
		return nil, nil
	}
	frame := r.data
	r.data = nil
	r.complete = true
	return frame, nil
}

func fragments(frame []byte, generation, rank uint64, stride uint32, send func([]byte) error) error {
	if len(frame) < 14 || len(frame) > maximumFrame || generation == 0 || rank == 0 || stride < 32 || stride > maximumFrame {
		return errFrame
	}
	for first, part := 0, uint32(0); first < len(frame); first, part = first+int(stride), part+1 {
		end := first + int(stride)
		if end > len(frame) {
			end = len(frame)
		}
		packet := make([]byte, headerBytes+end-first)
		binary.LittleEndian.PutUint32(packet, 1)
		binary.LittleEndian.PutUint32(packet[4:], uint32(len(frame)))
		binary.LittleEndian.PutUint64(packet[8:], generation)
		binary.LittleEndian.PutUint64(packet[16:], rank)
		binary.LittleEndian.PutUint32(packet[24:], part)
		binary.LittleEndian.PutUint32(packet[28:], stride)
		copy(packet[headerBytes:], frame[first:end])
		if err := send(packet); err != nil {
			return err
		}
	}
	return nil
}
