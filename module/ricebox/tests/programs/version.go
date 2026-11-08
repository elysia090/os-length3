// A Go program the way `git-lfs version` runs: the runtime starts its
// threads (sysmon, the GC's workers, one per P), goroutines meet on a
// channel and a WaitGroup, a collection runs, and the version line is
// printed.
package main

import (
	"fmt"
	"os"
	"runtime"
	"sync"
)

func main() {
	var wg sync.WaitGroup
	results := make(chan int, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			s := 0
			for k := 0; k < 100000; k++ {
				s += k % (n + 1)
			}
			results <- s
		}(i)
	}
	wg.Wait()
	close(results)
	total := 0
	for r := range results {
		total += r
	}
	runtime.GC()
	fmt.Printf("git-lfs/3.4.1 (GitHub; linux amd64; go %s)\n", runtime.Version())
	fmt.Println("total", total)
	if len(os.Args) > 3 {
		os.Exit(3)
	}
}
