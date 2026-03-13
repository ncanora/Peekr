# Peekr

A real-time network monitoring tool with algorithmic attack detection and LLM-assisted log analysis. Built with React + TypeScript (frontend) and Go + gopacket (backend).

![Peekr UI prototype](ui_proto.png)

*UI Prototype

---

## Architecture

![Peekr architecture diagram](architecture.png)

### File breakdown

| File | Responsibility |
|---|---|
| `devices.go` | One-time setup: enumerate interfaces, resolve own IP, return `pcap.Handle` |
| `net.go` | Two goroutines: capture loop → ring buffer, broadcast goroutine → SSE |
| `analyzer.go` | Reads ring buffer concurrently, runs local detection rules, pushes to alert channel |
| `llm.go` | Consumes alert channel + user requests, builds context, calls LLM API |
| `logger.go` | Structured JSON logging; doubles as LLM long-term context |

### Data flow

**Live feed**
```
gopacket capture → ring buffer → broadcast goroutine → SSE → React packet table
```

**Attack detection** (fully local, no API calls)
```
ring buffer → analyzer goroutine → Alert{severity, type, evidence} → alert channel → React alert panel
```

**LLM mode 1 — log selection**
```
user selects rows → "Ask LLM" button → POST /api/llm/selection
→ llm.go builds tight context from selected rows → Anthropic API → React chat panel
```

**LLM mode 2 — generic chat**
```
user clicks chat button → POST /api/llm/chat
→ llm.go injects recent log tail as background context → Anthropic API → React chat panel
```

### Detectors (`analyzer.go`)

Each detector is stateful and self-contained, reading from the shared ring buffer.

| Detector | Technique |
|---|---|
| ARP spoofing | IP→MAC table; flag when MAC changes for a known IP or unsolicited ARP replies appear |
| Port scan | Count distinct dst ports per src IP in a rolling time window |
| SYN flood | Count SYNs without corresponding ACKs per src |
| DNS poisoning | Flag unsolicited DNS replies or mismatched transaction IDs |
| ICMP flood | Volume threshold per src within a time window |

### LLM integration

`llm.go` exposes two HTTP handlers. Both inject recent log context automatically — the difference is only what goes in the user message:

- `POST /api/llm/selection` — tight context: selected packet rows + "what is happening here?"
- `POST /api/llm/chat` — open context: recent log tail + user's free-form question

The React chat panel persists conversation history client-side and sends it on each request so the LLM maintains context across turns.

---

## Stack

- **Frontend**: React 19 + TypeScript + Vite
- **Backend**: Go + [gopacket](https://github.com/google/gopacket)
- **LLM**: Anthropic API (via `llm.go`)
- **Transport**: SSE for live packet stream, REST for LLM queries

---

## Getting Started

### Prerequisites

- Go 1.21+
- Node.js 18+
- libpcap (`sudo apt install libpcap-dev` / `brew install libpcap`)
  - must install npcap for Windows (Select compatability mode + support raw 802.11 if on WiFi)

### Backend

```bash
cd backend
go mod tidy
sudo go run main.go   # sudo required for raw packet capture
```

### Frontend

```bash
npm install
npm run dev
```

---

## Development / Lab Setup

For safe testing without a shared network, use a personal hotspot or host-only VM network:

```
[Machine A — victim]  ←── hotspot / host-only ───→  [Machine B — attacker]
```

Simulate an ARP spoofing attack against your own device:

```bash
sudo apt install dsniff
sudo arpspoof -i eth0 -t <victim_ip> <gateway_ip>
sudo arpspoof -i eth0 -t <gateway_ip> <victim_ip>
```

Peekr's ARP detector will flag the attack in the alert panel in real time.

---

## Vite / ESLint Notes

### Type-aware lint rules

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
])
```

Optionally add [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific rules.

### React Compiler

Not enabled by default due to build performance impact. See the [React Compiler docs](https://react.dev/learn/react-compiler/installation) to add it.
