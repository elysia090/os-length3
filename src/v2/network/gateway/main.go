// Packet gateway: QUIC terminates here; guest TCP, TLS and Linux semantics do not.
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

func localAddress(address string) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return errors.New("gateway listeners must use explicit loopback IPs")
	}
	return nil
}

func certificate() (tls.Certificate, string, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, "", err
	}
	now := time.Now()
	template := x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "local packet gateway"},
		NotBefore: now.Add(-time.Minute), NotAfter: now.Add(13 * 24 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback}}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	hash := sha256.Sum256(der)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, base64.StdEncoding.EncodeToString(hash[:]), nil
}

type hello struct {
	Version    uint32 `json:"version"`
	Generation uint64 `json:"generation,string"`
	Stride     uint32 `json:"stride"`
}

func runSession(s *webtransport.Session, echo bool, tap *os.File, factory ...func() (ethernetLink, error)) error {
	defer s.CloseWithError(0, "link closed")
	ctx, cancel := context.WithTimeout(s.Context(), time.Hour)
	defer cancel()
	setup, stop := context.WithTimeout(ctx, 5*time.Second)
	defer stop()
	control, err := s.AcceptStream(setup)
	if err != nil {
		return err
	}
	control.SetReadDeadline(time.Now().Add(5 * time.Second))
	control.SetWriteDeadline(time.Now().Add(5 * time.Second))
	var h hello
	decoder := json.NewDecoder(io.LimitReader(control, 1024))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&h); err != nil {
		return err
	}
	if h.Version != 1 || h.Generation == 0 || h.Stride < 32 || h.Stride > 1068 {
		return errFrame
	}
	if err = json.NewEncoder(control).Encode(map[string]any{"version": 1, "generation": fmt.Sprint(h.Generation), "stride": h.Stride, "mtu": 1500, "mode": map[bool]string{true: "diagnostic-echo", false: "granted-ethernet"}[echo]}); err != nil {
		return err
	}
	control.Close()
	var link ethernetLink
	if !echo {
		if len(factory) > 0 && factory[0] != nil {
			link, err = factory[0]()
			if err != nil {
				return err
			}
		} else {
			link = tapLink{tap}
		}
		defer link.Close()
	}
	// No unbounded ingress backlog: one serialized reassembly owner and one
	// bounded synchronous frame handoff. Congestion is loss, not TCP retry.
	w := frameWindow{generation: h.Generation, stride: h.Stride}
	rank := uint64(0)
	if !echo {
		finished := make(chan struct{})
		defer func() { cancel(); <-finished }()
		go func() {
			defer close(finished)
			defer cancel()
			buf := make([]byte, maximumFrame+1)
			var outgoing uint64
			for {
				n, err := link.ReadFrame(ctx, buf)
				if err != nil {
					return
				}
				if n < 14 || n > maximumFrame {
					continue
				}
				outgoing++
				if outgoing == 0 {
					return
				}
				if err := fragments(buf[:n], h.Generation, outgoing, h.Stride, s.SendDatagram); err != nil {
					return
				}
			}
		}()
	}
	start := time.Now()
	received := uint64(0)
	for {
		packet, err := s.ReceiveDatagram(ctx)
		if err != nil {
			return err
		}
		// Fixed lifetime traffic budget (64 MiB/hour) and bounded burst rate.
		received += uint64(len(packet))
		if received > 64<<20 {
			return errors.New("session byte grant exhausted")
		}
		now := time.Now()
		if received > 1048576+uint64(now.Sub(start).Seconds()*1048576) {
			return errors.New("session rate exceeded")
		}
		frame, err := w.accept(packet, now)
		if err != nil || frame == nil {
			continue
		}
		if echo {
			rank++
			if rank == 0 {
				return errFrame
			}
			if err := fragments(frame, h.Generation, rank, h.Stride, s.SendDatagram); err != nil {
				return err
			}
		} else if err = link.WriteFrame(frame); err != nil {
			return err
		}
	}
}

func main() {
	listen := flag.String("listen", "127.0.0.1:8444", "QUIC listener (loopback only)")
	controlAddress := flag.String("control", "127.0.0.1:8084", "local pinned transport test/control listener")
	origin := flag.String("origin", "http://127.0.0.1:8084", "exact authorized browser Origin")
	echo := flag.Bool("diagnostic-echo", false, "opaque Ethernet echo; NOT Internet connectivity")
	tapFD := flag.Int("tap-fd", -1, "already authorized/opened Ethernet TAP descriptor; never created here")
	userNetwork := flag.String("user-network-dll", "", "optional pinned official libslirp Windows packet NAT; never a guest CPU/backend")
	userDigest := flag.String("user-network-sha256", "", "independently pinned DLL SHA-256")
	assets := flag.String("assets", "", "optional local browser verification repository; restricted public paths only")
	flag.Parse()
	for _, address := range []string{*listen, *controlAddress} {
		if err := localAddress(address); err != nil {
			log.Fatal(err)
		}
	}
	allowed, err := url.Parse(*origin)
	if err != nil || allowed.Scheme != "http" && allowed.Scheme != "https" || allowed.Host == "" || allowed.Path != "" || allowed.RawQuery != "" || allowed.Fragment != "" || allowed.User != nil {
		log.Fatal("exact HTTP(S) origin required")
	}
	selected := 0
	for _, value := range []bool{*echo, *tapFD >= 0, *userNetwork != ""} {
		if value {
			selected++
		}
	}
	if selected != 1 || (*userNetwork != "") != (*userDigest != "") {
		log.Fatal("choose one explicit diagnostic echo, authorized TAP, or pinned user-network DLL")
	}
	var tap *os.File
	if *tapFD >= 0 {
		tap = os.NewFile(uintptr(*tapFD), "authorized-tap")
		if tap == nil {
			log.Fatal("invalid TAP descriptor")
		}
		defer tap.Close()
		if err := validateTAP(tap); err != nil {
			log.Fatal(err)
		}
	}
	cert, hash, err := certificate()
	if err != nil {
		log.Fatal(err)
	}
	tokenBytes := make([]byte, 32)
	if _, err = rand.Read(tokenBytes); err != nil {
		log.Fatal(err)
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	var occupied atomic.Bool
	h3 := &http3.Server{Addr: *listen, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS13, NextProtos: []string{http3.NextProtoH3}, Certificates: []tls.Certificate{cert}},
		QUICConfig: &quic.Config{EnableDatagrams: true, EnableStreamResetPartialDelivery: true, MaxIncomingStreams: 4, MaxIncomingUniStreams: 4, MaxIdleTimeout: 30 * time.Second, KeepAlivePeriod: 5 * time.Second}}
	server := &webtransport.Server{H3: h3, CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == *origin }}
	mux := http.NewServeMux()
	h3.Handler = mux
	mux.HandleFunc("/network", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != *origin || subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("grant")), []byte(token)) != 1 {
			http.Error(w, "grant denied", 403)
			return
		}
		if !occupied.CompareAndSwap(false, true) {
			http.Error(w, "link already owned", 409)
			return
		}
		defer occupied.Store(false)
		s, err := server.Upgrade(w, r)
		if err != nil {
			log.Printf("upgrade: %v", err)
			return
		}
		var factory func() (ethernetLink, error)
		if *userNetwork != "" {
			factory = func() (ethernetLink, error) { return openUserNetwork(*userNetwork, *userDigest) }
		}
		if err := runSession(s, *echo, tap, factory); err != nil {
			log.Printf("link: %v", err)
		}
	})
	webtransport.ConfigureHTTP3Server(h3)
	controlMux := http.NewServeMux()
	controlMux.HandleFunc("/config", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.Header.Get("Origin") != "" && r.Header.Get("Origin") != *origin {
			http.Error(w, "origin denied", 403)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Origin") == *origin {
			w.Header().Set("Access-Control-Allow-Origin", *origin)
			w.Header().Set("Vary", "Origin")
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		json.NewEncoder(w).Encode(map[string]any{"url": "https://" + *listen + "/network?grant=" + token, "certificateHash": hash, "diagnostic": *echo})
	})
	controlMux.HandleFunc("/probe", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self' https://"+*listen+"; base-uri 'none'")
		fmt.Fprint(w, probeHTML)
	})
	controlMux.HandleFunc("/probe.mjs", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript")
		fmt.Fprint(w, probeJS)
	})
	if *assets != "" {
		root, err := filepath.Abs(*assets)
		if err != nil {
			log.Fatal(err)
		}
		controlMux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			p := r.URL.Path
			if (r.Method != "GET" && r.Method != "HEAD") ||
				!(strings.HasPrefix(p, "/src/v2/web/") || strings.HasPrefix(p, "/src/v2/vm/check/browser/") || strings.HasPrefix(p, "/artifact/browser-")) {
				http.NotFound(w, r)
				return
			}
			for _, part := range strings.Split(p, "/") {
				if strings.HasPrefix(part, ".") || strings.Contains(part, "\\") {
					http.NotFound(w, r)
					return
				}
			}
			file, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(p)))
			if err != nil || !strings.HasPrefix(file, root+string(filepath.Separator)) {
				http.NotFound(w, r)
				return
			}
			f, err := os.Open(file)
			if err != nil {
				http.NotFound(w, r)
				return
			}
			defer f.Close()
			info, err := f.Stat()
			if err != nil || !info.Mode().IsRegular() {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' https://"+*listen+"; style-src 'self'; base-uri 'none'")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("Cache-Control", "no-store")
			if strings.HasSuffix(file, ".mjs") || strings.HasSuffix(file, ".js") {
				w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			}
			http.ServeContent(w, r, info.Name(), info.ModTime(), f)
		})
	}
	localControl := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Pin Host as well as Origin. A rebinding DNS name must not acquire
		// the loopback control capability merely by reaching this socket.
		if r.Host != *controlAddress {
			http.Error(w, "control authority denied", 403)
			return
		}
		controlMux.ServeHTTP(w, r)
	})
	httpServer := &http.Server{Addr: *controlAddress, Handler: localControl, ReadHeaderTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go func() {
		<-ctx.Done()
		server.Close()
		httpServer.Shutdown(context.Background())
		if tap != nil {
			tap.Close()
		}
	}()
	go func() {
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("control: %v", err)
			stop()
		}
	}()
	mode := "authorized-tap"
	if *userNetwork != "" {
		mode = "pinned-packet-nat"
	}
	if *echo {
		mode = "diagnostic-echo"
	}
	log.Printf("local packet transport probe http://%s/probe (backend=%s; Internet acceptance is separate)", *controlAddress, mode)
	if err = server.ListenAndServe(); err != nil && ctx.Err() == nil {
		log.Fatal(err)
	}
}
