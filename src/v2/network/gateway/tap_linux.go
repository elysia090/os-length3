package main

import (
	"context"
	"errors"
	"io"
	"os"

	"golang.org/x/sys/unix"
)

func validateTAP(file *os.File) error {
	ifr, err := unix.NewIfreq("")
	if err != nil {
		return err
	}
	if err = unix.IoctlIfreq(int(file.Fd()), unix.TUNGETIFF, ifr); err != nil {
		return err
	}
	flags := ifr.Uint16()
	if flags&unix.IFF_TAP == 0 || flags&unix.IFF_NO_PI == 0 {
		return errors.New("expected already-opened TAP with IFF_NO_PI")
	}
	return unix.SetNonblock(int(file.Fd()), true)
}

func readTAP(ctx context.Context, file *os.File, buffer []byte) (int, error) {
	fd := int(file.Fd())
	poll := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
	for {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		n, err := unix.Read(fd, buffer)
		if err == nil {
			return n, nil
		}
		if err != unix.EAGAIN && err != unix.EINTR {
			return 0, err
		}
		if _, err = unix.Poll(poll, 100); err != nil && err != unix.EINTR {
			return 0, err
		}
	}
}

func writeTAP(file *os.File, frame []byte) error {
	n, err := unix.Write(int(file.Fd()), frame)
	if err == unix.EAGAIN || err == unix.EINTR {
		return nil
	} // declared congestion loss
	if err != nil {
		return err
	}
	if n != len(frame) {
		return io.ErrShortWrite
	}
	return nil
}
