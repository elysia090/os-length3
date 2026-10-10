package main

import (
	"context"
	"os"
)

type ethernetLink interface {
	ReadFrame(context.Context, []byte) (int, error)
	WriteFrame([]byte) error
	Close() error
}
type tapLink struct{ file *os.File }

func (t tapLink) ReadFrame(ctx context.Context, b []byte) (int, error) {
	return readTAP(ctx, t.file, b)
}
func (t tapLink) WriteFrame(b []byte) error { return writeTAP(t.file, b) }
func (t tapLink) Close() error              { return nil } // The supervisor owns this granted FD.
