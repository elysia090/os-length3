package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

func TestRealQUICDatagrams(t *testing.T) {
	cert, _, err := certificate()
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	parsed, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	pool.AddCert(parsed)
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	server := &webtransport.Server{H3: &http3.Server{TLSConfig: &tls.Config{NextProtos: []string{http3.NextProtoH3}, Certificates: []tls.Certificate{cert}}, QUICConfig: &quic.Config{EnableDatagrams: true, EnableStreamResetPartialDelivery: true}},
		CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "http://127.0.0.1:8084" }}
	server.H3.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s, err := server.Upgrade(w, r)
		if err != nil {
			return
		}
		runSession(s, true, nil)
	})
	defer server.Close()
	go server.Serve(conn)
	client := &webtransport.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}, QUICConfig: &quic.Config{EnableDatagrams: true, EnableStreamResetPartialDelivery: true}}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	header := http.Header{"Origin": []string{"http://127.0.0.1:8084"}}
	response, s, err := client.Dial(ctx, "https://"+conn.LocalAddr().String()+"/network", header)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 {
		t.Fatal(response.StatusCode)
	}
	defer s.CloseWithError(0, "")
	stream, err := s.OpenStreamSync(ctx)
	if err != nil {
		t.Fatal(err)
	}
	generation := ^uint64(0)
	json.NewEncoder(stream).Encode(hello{1, generation, 500})
	var link map[string]any
	if err = json.NewDecoder(stream).Decode(&link); err != nil {
		t.Fatal(err)
	}
	if link["generation"] != "18446744073709551615" {
		t.Fatal("generation lost precision")
	}
	frame := make([]byte, 1514)
	for i := range frame {
		frame[i] = byte(i)
	}
	p := packets(t, frame, generation, 1, 500)
	for i := len(p) - 1; i >= 0; i-- {
		if err = s.SendDatagram(p[i]); err != nil {
			t.Fatal(err)
		}
	}
	w := frameWindow{generation: generation, stride: 500}
	for {
		packet, err := s.ReceiveDatagram(ctx)
		if err != nil {
			t.Fatal(err)
		}
		b, err := w.accept(packet, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if b != nil {
			for i := range b {
				if b[i] != frame[i] {
					t.Fatal("payload mismatch")
				}
			}
			break
		}
	}
}
