//go:build linux

// Disposable oracle-host setup only, never part of the browser VM or gateway.
// Requires the pinned Alpine test VM, its private slirp address, and explicit
// authorization. No interface, forwarding policy or route on Windows changes.
package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"golang.org/x/sys/unix"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}
func command(name string, args ...string) {
	c := exec.Command(name, args...)
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	must(c.Run())
}
func tcpProxy() {
	l, e := net.Listen("tcp", "10.0.2.15:8086")
	must(e)
	for {
		a, e := l.Accept()
		if e != nil {
			return
		}
		go func() {
			defer a.Close()
			b, e := net.DialTimeout("tcp", "127.0.0.1:8086", time.Second)
			if e != nil {
				return
			}
			defer b.Close()
			a.SetDeadline(time.Now().Add(30 * time.Second))
			b.SetDeadline(time.Now().Add(30 * time.Second))
			done := make(chan struct{})
			go func() { io.Copy(b, a); close(done) }()
			io.Copy(a, b)
			a.Close()
			b.Close()
			<-done
		}()
	}
}
func udpProxy() {
	address, e := net.ResolveUDPAddr("udp", "10.0.2.15:8445")
	must(e)
	socket, e := net.ListenUDP("udp", address)
	must(e)
	type peer struct {
		remote *net.UDPConn
		last   time.Time
	}
	peers := map[string]*peer{}
	var lock sync.Mutex
	buffer := make([]byte, 2048)
	var ingress uint64
	for {
		n, client, e := socket.ReadFromUDP(buffer)
		if e != nil {
			return
		}
		ingress++
		if ingress <= 8 {
			fmt.Printf("network-oracle UDP ingress: bytes=%d peer=%s\n", n, client.String())
		}
		if n > 1500 {
			continue
		}
		key := client.String()
		lock.Lock()
		for k, p := range peers {
			if time.Since(p.last) > time.Minute {
				p.remote.Close()
				delete(peers, k)
			}
		}
		p := peers[key]
		if p == nil {
			if len(peers) >= 8 {
				lock.Unlock()
				continue
			}
			remote, e := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 8445})
			if e != nil {
				lock.Unlock()
				continue
			}
			p = &peer{remote: remote, last: time.Now()}
			peers[key] = p
			go func() {
				reply := make([]byte, 2048)
				var replies uint64
				for {
					remote.SetReadDeadline(time.Now().Add(time.Minute))
					n, e := remote.Read(reply)
					if e != nil {
						remote.Close()
						return
					}
					_, sent := socket.WriteToUDP(reply[:n], client)
					replies++
					if replies <= 4 {
						fmt.Printf("network-oracle UDP reply: bytes=%d error=%v\n", n, sent)
					}
				}
			}()
		}
		p.last = time.Now()
		p.remote.Write(buffer[:n])
		lock.Unlock()
	}
}

// Test-only opaque QUIC datagram tunnel. Fixed destination and private oracle
// listener avoid changing Windows firewall or widening the browser grant.
func udpTunnel() {
	listener, err := net.Listen("tcp", "10.0.2.15:8088")
	must(err)
	active := make(chan struct{}, 8)
	for {
		client, err := listener.Accept()
		if err != nil { return }
		select {case active<-struct{}{}:default:client.Close();continue}
		go func(client net.Conn) {
			defer func(){<-active}()
			defer client.Close()
			remote, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.IPv4(127,0,0,1), Port:8445})
			if err != nil { return };defer remote.Close()
			go func(){
				defer client.Close();packet:=make([]byte,2049)
				for {remote.SetReadDeadline(time.Now().Add(time.Minute));n,err:=remote.Read(packet);if err!=nil||n>2048{return}
					var size [4]byte;binary.BigEndian.PutUint32(size[:],uint32(n));client.SetWriteDeadline(time.Now().Add(10*time.Second))
					if _,err=client.Write(size[:]);err!=nil{return};if _,err=client.Write(packet[:n]);err!=nil{return}}
			}()
			var size [4]byte;packet:=make([]byte,2048)
			for {client.SetReadDeadline(time.Now().Add(time.Minute));if _,err=io.ReadFull(client,size[:]);err!=nil{return}
				n:=binary.BigEndian.Uint32(size[:]);if n<1||n>2048{return};if _,err=io.ReadFull(client,packet[:n]);err!=nil{return}
				if _,err=remote.Write(packet[:n]);err!=nil{return}}
		}(client)
	}
}
func main() {
	if len(os.Args) != 3 || os.Args[1] != "--isolated-test" || os.Geteuid() != 0 {
		panic("explicit disposable Linux network oracle only")
	}
	release, e := os.ReadFile("/etc/alpine-release")
	must(e)
	if !strings.HasPrefix(string(release), "3.24.") {
		panic("pinned Alpine test host")
	}
	iface, e := net.InterfaceByName("eth0")
	must(e)
	addrs, e := iface.Addrs()
	must(e)
	valid := false
	for _, a := range addrs {
		if strings.HasPrefix(a.String(), "10.0.2.15/") {
			valid = true
		}
	}
	if !valid {
		panic("private oracle uplink required")
	}
	command("modprobe", "tun")
	file, e := os.OpenFile("/dev/net/tun", os.O_RDWR, 0)
	must(e)
	defer file.Close()
	ifr, e := unix.NewIfreq("l3probe0")
	must(e)
	ifr.SetUint16(unix.IFF_TAP | unix.IFF_NO_PI)
	must(unix.IoctlIfreq(int(file.Fd()), unix.TUNSETIFF, ifr))
	command("ip", "addr", "add", "10.55.0.1/24", "dev", "l3probe0")
	command("ip", "link", "set", "l3probe0", "up")
	command("ip", "addr", "add", "10.0.3.15/24", "dev", "eth1")
	command("ip", "link", "set", "eth1", "up")
	command("ip", "route", "replace", "default", "via", "10.0.3.2", "dev", "eth1")
	must(os.WriteFile("/proc/sys/net/ipv4/ip_forward", []byte("1\n"), 0600))
	c := exec.Command("/run/nft", "-f", "-")
	c.Stdin = bytes.NewBufferString(`table ip length3_probe {
  chain postrouting {
    type nat hook postrouting priority srcnat;
    ip saddr 10.55.0.0/24 oifname "eth1" masquerade
  }
}
`)
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	must(c.Run())
	go tcpProxy()
	go udpProxy()
	go udpTunnel()
	gateway := exec.Command(os.Args[2], "-tap-fd", "3", "-listen", "127.0.0.1:8445", "-control", "127.0.0.1:8086", "-origin", "http://127.0.0.1:8087")
	gateway.ExtraFiles = []*os.File{file}
	gateway.Stdout = os.Stdout
	gateway.Stderr = os.Stderr
	fmt.Println("network-oracle: authorized TAP, Linux forwarding, loopback-only host port projections; guest TCP/TLS untouched")
	must(gateway.Run())
}
