# PacketPeekr

A real-time network monitoring dashboard built with Go + React. Captures live packets off a network interface, streams them to a browser via SSE, and provides a dark-themed terminal-style UI for inspection and analysis.

![PacketPeekr UI](ui_proto.png)

---

## What it does right now

- Live packet capture via [gopacket](https://github.com/google/gopacket) + libpcap/npcap
- Real-time SSE stream to a React dashboard — no polling, no page refresh
- Parses TCP, UDP, ICMP, ARP, and DNS (including query/answer extraction)
- Payload capture and hex/ASCII viewer for TCP, UDP, ICMP, and DNS packets
- Protocol filtering, full-text search (IP, port, MAC, domain), and pause/resume
- Per-session bandwidth meter (upload / download)
- Up to 10,000 packets stored in-memory; newest 500 rendered at any time
- Packet detail drawer with all fields, DNS block, and raw payload viewer

---

## Architecture

![PacketPeekr Architecture](architecture.png)

```
gopacket capture → ring buffer → SSE broadcaster → React packet table
```
---

## Stack

- **Frontend** — React 19 + TypeScript + Vite
- **Backend** — Go + gopacket
- **Transport** — SSE for live stream, REST for future LLM queries

---

## Getting Started

### Prerequisites

- Go 1.21+
- Node.js 22+
- libpcap (`sudo apt install libpcap-dev` / `brew install libpcap`)
- Windows: install [npcap](https://npcap.com) with compatibility mode and raw 802.11 support enabled for WiFi

### Backend

```bash
cd backend
go mod tidy
sudo go run . -v          # verbose: one line per packet
sudo go run . -list       # list available interfaces
sudo go run . -iface eth0 # specify interface explicitly
```

### Frontend

```bash
npm install
npm run dev
```

The Vite dev server proxies `/api` to `localhost:8080` automatically.

---

## Roadmap

### Local Attack Detection Analyzer
Local, fully offline — no API calls involved.

| Detector | Technique |
|---|---|
| ARP spoofing | IP→MAC table; flag when MAC changes for a known IP, or unsolicited replies appear |
| Port scan | Count distinct destination ports per source IP in a rolling time window |
| SYN flood | Track SYNs without corresponding ACKs per source |
| DNS poisoning | Flag unsolicited DNS replies or transaction ID mismatches |
| ICMP flood | Volume threshold per source within a rolling window |

Alerts will appear in the **Alerts** tab with severity levels (high / medium / low) and the raw evidence packets.

### Local ML classifier
Train a classifier on a public labeled dataset (CICIDS-2017 or NSL-KDD) and integrate it as a second opinion alongside the rule-based detectors. The model runs locally — no data leaves the machine.

### LLM agent
Two interaction modes:

- **Selection mode** — select packet rows in the table → "Ask LLM" → tight context sent to the model with a focused question
- **Chat mode** — open-ended conversation with recent log tail injected as background context automatically

The agent will have tools: query packet history, correlate alerts, explain detections in plain English, and suggest mitigations.

### Persistence and graphing
- Structured JSON logging (`logger.go`) — doubles as long-term LLM context
- Network speed graphs over time (up/down throughput)
- PCAP export

---

## Lab Setup

For safe attack simulation without a shared network, use a personal hotspot or a host-only VM interface:

```
[Machine A — victim]  <── hotspot / host-only ──>  [Machine B — attacker]
```

Simulate ARP spoofing:

```bash
sudo apt install dsniff
sudo arpspoof -i eth0 -t <victim_ip> <gateway_ip>
sudo arpspoof -i eth0 -t <gateway_ip> <victim_ip>
```

The ARP detector will flag it in the Alerts tab in real time once Phase 1 is complete.
