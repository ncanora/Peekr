package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
)

// SSEClient represents a connected React frontend listener.
type SSEClient struct {
	send chan PacketInfo
}

// SSEBroadcaster manages all connected SSE clients.
type SSEBroadcaster struct {
	mu      sync.Mutex
	clients map[*SSEClient]struct{}
}

var broadcaster = &SSEBroadcaster{
	clients: make(map[*SSEClient]struct{}),
}

func (b *SSEBroadcaster) add(c *SSEClient) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.clients[c] = struct{}{}
}

func (b *SSEBroadcaster) remove(c *SSEClient) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.clients, c)
	close(c.send)
}

// Broadcast fans a packet out to all connected clients.
// Drops the packet for any client whose buffer is full (non-blocking).
func (b *SSEBroadcaster) Broadcast(p PacketInfo) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for c := range b.clients {
		select {
		case c.send <- p:
		default:
			// client too slow, drop rather than block capture
		}
	}
}

// StartBroadcaster reads from packetCh and fans out to SSE clients.
// Run this in a goroutine.
func StartBroadcaster(packetCh <-chan PacketInfo) {
	for p := range packetCh {
		broadcaster.Broadcast(p)
	}
}

// handlePackets is the SSE endpoint — GET /api/packets
func handlePackets(w http.ResponseWriter, r *http.Request) {
	// SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	client := &SSEClient{send: make(chan PacketInfo, 64)}
	broadcaster.add(client)
	defer broadcaster.remove(client)

	log.Printf("[sse] client connected: %s", r.RemoteAddr)

	for {
		select {
		case p, ok := <-client.send:
			if !ok {
				return
			}
			data, err := json.Marshal(p)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()

		case <-r.Context().Done():
			log.Printf("[sse] client disconnected: %s", r.RemoteAddr)
			return
		}
	}
}

// handleHealth is a simple liveness check — GET /api/health
func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	fmt.Fprintln(w, `{"status":"ok"}`)
}

// StartServer starts the HTTP server on the given port.
// Run this in a goroutine.
func StartServer(port int) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/packets", handlePackets)
	mux.HandleFunc("/api/health", handleHealth)

	addr := fmt.Sprintf(":%d", port)
	log.Printf("[server] listening on http://localhost%s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("server error: %v", err)
	}
}