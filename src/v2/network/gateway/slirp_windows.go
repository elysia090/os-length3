//go:build windows && cgo

package main

/*
#cgo CFLAGS: -I${SRCDIR}/../../../../data/upstream/network-slirp
#cgo LDFLAGS: -lws2_32
#include "slirp_windows.h"
*/
import "C"
import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"unsafe"
)

type userNetworkLink struct {
	mutex sync.Mutex
	owner *C.packet_nat
}

func openUserNetwork(file, digest string) (ethernetLink, error) {
	path, err := filepath.Abs(file)
	if err != nil {
		return nil, err
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return nil, err
	}
	if filepath.Base(path) != "libslirp-0.dll" {
		return nil, errors.New("explicit official libslirp DLL required")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(raw)
	if len(raw) > 1048576 || hex.EncodeToString(sum[:]) != digest {
		return nil, errors.New("pinned user-network DLL identity")
	}
	wide, err := syscall.UTF16FromString(path)
	if err != nil {
		return nil, err
	}
	owner := C.packet_nat_open((*C.uint16_t)(unsafe.Pointer(&wide[0])))
	if owner == nil {
		return nil, errors.New("libslirp v6 full-width socket ABI/dependencies unavailable; no compatibility fallback")
	}
	fmt.Fprintf(os.Stderr, "packet NAT: libslirp %s, loopback/TFTP/unsafe emulation disabled; guest Linux TCP/TLS unchanged\n", C.GoString(C.packet_nat_version(owner)))
	return &userNetworkLink{owner: owner}, nil
}
func (n *userNetworkLink) ReadFrame(ctx context.Context, b []byte) (int, error) {
	if len(b) < 2048 {
		return 0, errors.New("bounded packet receive buffer")
	}
	for {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		n.mutex.Lock()
		if n.owner == nil {
			n.mutex.Unlock()
			return 0, errors.New("packet NAT closed")
		}
		count := int(C.packet_nat_read(n.owner, (*C.uint8_t)(unsafe.Pointer(&b[0])), C.int(len(b))))
		n.mutex.Unlock()
		if count < 0 {
			return 0, errors.New("packet NAT poll")
		}
		if count > 0 {
			return count, nil
		}
	}
}
func (n *userNetworkLink) WriteFrame(b []byte) error {
	if len(b) < 14 || len(b) > 2048 {
		return errors.New("bounded packet send")
	}
	n.mutex.Lock()
	defer n.mutex.Unlock()
	if n.owner == nil {
		return errors.New("packet NAT closed")
	}
	if C.packet_nat_input(n.owner, (*C.uint8_t)(unsafe.Pointer(&b[0])), C.int(len(b))) != 0 {
		return errors.New("packet NAT input")
	}
	return nil
}
func (n *userNetworkLink) Close() error {
	n.mutex.Lock()
	defer n.mutex.Unlock()
	if n.owner != nil {
		C.packet_nat_close(n.owner)
		n.owner = nil
	}
	return nil
}
