package main

import (
	"flag"
	"fmt"
	"log"
	"os"
)

const maxPacketBuffer = 2000

var packetCh = make(chan PacketInfo, maxPacketBuffer/4)

func main() {
	// Flags
	iface := flag.String("iface", "", "network interface to capture on (e.g. eth0, en0)")
	debug := flag.Bool("debug", false, "print full per-packet report to stdout")
	verbose := flag.Bool("v", false, "print one-line summary per packet")
	maxPackets := flag.Int("n", 0, "number of packets to capture before stopping (0 = infinite)")
	listIfaces := flag.Bool("list", false, "list available interfaces and exit")
	port := flag.Int("port", 8080, "HTTP server port")
	flag.Parse()

	if *listIfaces {
		fmt.Println("Available interfaces:")
		if err := ListDevices(); err != nil {
			log.Fatal(err)
		}
		os.Exit(0)
	}

	if *iface == "" {
		if *debug {
			fmt.Fprintln(os.Stderr, "error: -iface required in debug mode. Run with -list to see available interfaces.")
			flag.Usage()
			os.Exit(1)
		}
		detected, err := GetDefaultIface()
		if err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
		fmt.Printf("auto-detected interface: %s\n", detected)
		*iface = detected
	}

	cfg := CaptureConfig{
		Iface:      *iface,
		MaxPackets: *maxPackets,
		Debug:      *debug,
		Verbose:    *verbose,
	}

	fmt.Printf("Peekr starting on interface: %s\n", cfg.Iface)
	if cfg.Debug {
		limit := "infinite"
		if cfg.MaxPackets > 0 {
			limit = fmt.Sprintf("%d", cfg.MaxPackets)
		}
		fmt.Printf("[debug] mode on — capturing %s packets\n\n", limit)
	}

	// Start HTTP server
	go StartServer(*port)

	// Start broadcaster — reads packetCh, fans out to SSE clients
	go StartBroadcaster(packetCh)

	if err := StartCapture(cfg, packetCh); err != nil {
		log.Fatalf("capture error: %v", err)
	}
}
