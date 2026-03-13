package main

import (
	"fmt"
	"net"

	"github.com/google/gopacket/pcap"
)

// ListDevices prints all available network interfaces with their IPs.
func ListDevices() error {
	devices, err := pcap.FindAllDevs()
	if err != nil {
		return fmt.Errorf("finding devices: %w", err)
	}
	for _, d := range devices {
		fmt.Printf("  [%s] %s\n", d.Name, d.Description)
		for _, addr := range d.Addresses {
			fmt.Printf("      IP: %s\n", addr.IP)
		}
	}
	return nil
}

// OpenHandle opens a live capture handle on the given interface.
func OpenHandle(iface string) (*pcap.Handle, error) {
	return pcap.OpenLive(iface, 1600, true, pcap.BlockForever)
}

// GetLocalIPs returns all non-loopback IPs on the machine.
// Used to identify which traffic is ours vs foreign.
func GetLocalIPs() ([]net.IP, error) {
	var ips []net.IP
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, fmt.Errorf("listing interfaces: %w", err)
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip != nil && ip.To4() != nil {
				ips = append(ips, ip)
			}
		}
	}
	return ips, nil
}

// GetDefaultIface returns the first npcap device with a routable IPv4 address.
// Skips loopback, link-local (169.254.x.x), multicast, and unspecified addresses.
// Falls back with an error if nothing routable is found.
func GetDefaultIface() (string, error) {
	devices, err := pcap.FindAllDevs()
	if err != nil {
		return "", fmt.Errorf("finding devices: %w", err)
	}
	for _, d := range devices {
		for _, addr := range d.Addresses {
			ip := addr.IP.To4()
			if ip == nil {
				continue
			}
			if isRoutableIP(ip) {
				return d.Name, nil
			}
		}
	}
	return "", fmt.Errorf("no routable interface found — run -list and pass -iface manually")
}

// isRoutableIP returns true if the IP is a real routable address.
// Filters out loopback, link-local (169.254.x.x), multicast, and unspecified.
func isRoutableIP(ip net.IP) bool {
	return !ip.IsLoopback() &&
		!ip.IsLinkLocalUnicast() &&
		!ip.IsUnspecified() &&
		!ip.IsMulticast()
}
