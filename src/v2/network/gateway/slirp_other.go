//go:build !windows || !cgo

package main

import "errors"

func openUserNetwork(path, digest string) (ethernetLink, error) {
	return nil, errors.New("user-network DLL requires Windows/cgo; use an explicitly granted TAP instead")
}
