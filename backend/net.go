package main

import (
	"fmt"
	"net"
	"time"

	"github.com/google/gopacket"
	"github.com/google/gopacket/layers"
)

// Proto represents the detected protocol of a captured packet.
type Proto string

const (
	ProtoTCP     Proto = "TCP"
	ProtoUDP     Proto = "UDP"
	ProtoICMP    Proto = "ICMP"
	ProtoARP     Proto = "ARP"
	ProtoUnknown Proto = "UNKNOWN"
)

// PacketInfo is the normalised struct we pass around internally.
// Raw gopacket.Packet is never sent to the frontend — always convert first.
type PacketInfo struct {
	Timestamp time.Time `json:"timestamp"`
	SrcIP     string    `json:"src_ip"`
	DstIP     string    `json:"dst_ip"`
	SrcMAC    string    `json:"src_mac"`
	DstMAC    string    `json:"dst_mac"`
	SrcPort   uint16    `json:"src_port"`
	DstPort   uint16    `json:"dst_port"`
	Protocol  Proto     `json:"protocol"`
	Length    int       `json:"length"`
	Info      string    `json:"info"` // human-readable summary
}

// CaptureConfig holds runtime options for the capture loop.
type CaptureConfig struct {
	Iface      string
	MaxPackets int  // 0 = infinite
	Debug      bool // print full per-packet report
	Verbose    bool // print rolling summary every 100 packets
}

// captureStats tracks protocol counts for verbose mode.
type captureStats struct {
	TCP   int
	UDP   int
	ARP   int
	ICMP  int
	Other int
}

func (s *captureStats) record(p Proto) {
	switch p {
	case ProtoTCP:
		s.TCP++
	case ProtoUDP:
		s.UDP++
	case ProtoARP:
		s.ARP++
	case ProtoICMP:
		s.ICMP++
	default:
		s.Other++
	}
}

// printVerbose prints a one-line summary per packet.
func printVerbose(p PacketInfo, count int) {
	fmt.Printf("[%d] %-7s  %-21s -> %-21s  %d bytes\n",
		count, p.Protocol, srcLabel(p), dstLabel(p), p.Length)
}

// srcLabel returns "ip:port" if ports exist, otherwise just the IP.
func srcLabel(p PacketInfo) string {
	if p.SrcPort != 0 {
		return fmt.Sprintf("%s:%d", p.SrcIP, p.SrcPort)
	}
	return p.SrcIP
}

// dstLabel returns "ip:port" if ports exist, otherwise just the IP.
func dstLabel(p PacketInfo) string {
	if p.DstPort != 0 {
		return fmt.Sprintf("%s:%d", p.DstIP, p.DstPort)
	}
	return p.DstIP
}

// parsePacket converts a raw gopacket.Packet into a PacketInfo.
func parsePacket(pkt gopacket.Packet) PacketInfo {
	info := PacketInfo{
		Timestamp: pkt.Metadata().Timestamp,
		Length:    pkt.Metadata().Length,
	}

	// Ethernet layer — MAC addresses
	if eth, ok := pkt.Layer(layers.LayerTypeEthernet).(*layers.Ethernet); ok {
		info.SrcMAC = eth.SrcMAC.String()
		info.DstMAC = eth.DstMAC.String()
	}

	// ARP
	if arp, ok := pkt.Layer(layers.LayerTypeARP).(*layers.ARP); ok {
		info.Protocol = ProtoARP
		info.SrcIP = net.IP(arp.SourceProtAddress).String()
		info.DstIP = net.IP(arp.DstProtAddress).String()
		info.SrcMAC = net.HardwareAddr(arp.SourceHwAddress).String()
		info.Info = fmt.Sprintf("ARP who-has %s tell %s", info.DstIP, info.SrcIP)
		return info
	}

	// IPv4
	if ip4, ok := pkt.Layer(layers.LayerTypeIPv4).(*layers.IPv4); ok {
		info.SrcIP = ip4.SrcIP.String()
		info.DstIP = ip4.DstIP.String()
	}

	// IPv6
	if ip6, ok := pkt.Layer(layers.LayerTypeIPv6).(*layers.IPv6); ok {
		info.SrcIP = ip6.SrcIP.String()
		info.DstIP = ip6.DstIP.String()
	}

	// TCP
	if tcp, ok := pkt.Layer(layers.LayerTypeTCP).(*layers.TCP); ok {
		info.Protocol = ProtoTCP
		info.SrcPort = uint16(tcp.SrcPort)
		info.DstPort = uint16(tcp.DstPort)
		info.Info = fmt.Sprintf("TCP %s:%d → %s:%d", info.SrcIP, info.SrcPort, info.DstIP, info.DstPort)
		return info
	}

	// UDP
	if udp, ok := pkt.Layer(layers.LayerTypeUDP).(*layers.UDP); ok {
		info.Protocol = ProtoUDP
		info.SrcPort = uint16(udp.SrcPort)
		info.DstPort = uint16(udp.DstPort)
		info.Info = fmt.Sprintf("UDP %s:%d → %s:%d", info.SrcIP, info.SrcPort, info.DstIP, info.DstPort)
		return info
	}

	// ICMP
	if _, ok := pkt.Layer(layers.LayerTypeICMPv4).(*layers.ICMPv4); ok {
		info.Protocol = ProtoICMP
		info.Info = fmt.Sprintf("ICMP %s → %s", info.SrcIP, info.DstIP)
		return info
	}

	info.Protocol = ProtoUnknown
	info.Info = "unknown protocol"
	return info
}

// printReport pretty-prints a PacketInfo to stdout.
// Only called when CaptureConfig.Debug is true.
func printReport(p PacketInfo, count int) {
	fmt.Printf("──────────────────────────────────────\n")
	fmt.Printf("  #%-6d  %s\n", count, p.Timestamp.Format("15:04:05.000"))
	fmt.Printf("  Proto    : %s\n", p.Protocol)
	fmt.Printf("  Src      : %s  (MAC: %s)\n", p.SrcIP, p.SrcMAC)
	fmt.Printf("  Dst      : %s  (MAC: %s)\n", p.DstIP, p.DstMAC)
	if p.SrcPort != 0 || p.DstPort != 0 {
		fmt.Printf("  Ports    : %d → %d\n", p.SrcPort, p.DstPort)
	}
	fmt.Printf("  Length   : %d bytes\n", p.Length)
	fmt.Printf("  Info     : %s\n", p.Info)
}

// StartCapture opens the interface and feeds parsed packets into packetCh.
// Respects cfg.MaxPackets (0 = run forever), cfg.Debug, and cfg.Verbose.
func StartCapture(cfg CaptureConfig, packetCh chan<- PacketInfo) error {
	handle, err := OpenHandle(cfg.Iface)
	if err != nil {
		return fmt.Errorf("opening handle on %s: %w", cfg.Iface, err)
	}
	defer handle.Close()

	src := gopacket.NewPacketSource(handle, handle.LinkType())
	src.NoCopy = true

	count := 0

	for pkt := range src.Packets() {
		parsed := parsePacket(pkt)
		count++

		if cfg.Debug {
			printReport(parsed, count)
		} else if cfg.Verbose {
			printVerbose(parsed, count)
		}

		packetCh <- parsed

		if cfg.MaxPackets > 0 && count >= cfg.MaxPackets {
			fmt.Printf("\n[capture] done — %d packets captured\n", count)
			return nil
		}
	}
	return nil
}
