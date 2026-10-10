//go:build !linux

package main

import (
	"context"
	"errors"
	"os"
)

var errTAP = errors.New("TAP backend requires an explicitly supplied Linux TAP descriptor; diagnostic echo is portable")

func validateTAP(*os.File) error                             { return errTAP }
func readTAP(context.Context, *os.File, []byte) (int, error) { return 0, errTAP }
func writeTAP(*os.File, []byte) error                        { return errTAP }
