import {
  useEffect, useRef, useState, useMemo, useCallback, memo,
  Component, ReactNode
} from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

type Proto = 'TCP' | 'UDP' | 'ARP' | 'ICMP' | 'DNS' | 'UNKNOWN'

interface DNSInfo {
  is_response: boolean
  questions:   string[]
  answers:     string[]
}

interface Packet {
  timestamp:    string
  src_ip:       string
  dst_ip:       string
  src_mac:      string
  dst_mac:      string
  src_port:     number
  dst_port:     number
  protocol:     Proto
  length:       number
  info:         string
  dns?:         DNSInfo
  payload_hex?: string
  payload_len:  number
}

// Safe accessor helpers — every field treated as potentially null/undefined
const safe = {
  str:  (v: unknown, fallback = '—'): string  => (v != null && v !== '') ? String(v) : fallback,
  num:  (v: unknown, fallback = 0):   number  => (typeof v === 'number' && isFinite(v)) ? v : fallback,
  arr:  <T,>(v: unknown): T[]                 => Array.isArray(v) ? v as T[] : [],
  proto:(v: unknown): Proto => {
    const s = String(v ?? '').toUpperCase()
    return (['TCP','UDP','ARP','ICMP','DNS'] as Proto[]).includes(s as Proto) ? s as Proto : 'UNKNOWN'
  },
  packet(raw: unknown): Packet | null {
    if (raw == null || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    return {
      timestamp:   safe.str(r.timestamp, new Date().toISOString()),
      src_ip:      safe.str(r.src_ip, '0.0.0.0'),
      dst_ip:      safe.str(r.dst_ip, '0.0.0.0'),
      src_mac:     safe.str(r.src_mac, ''),
      dst_mac:     safe.str(r.dst_mac, ''),
      src_port:    safe.num(r.src_port),
      dst_port:    safe.num(r.dst_port),
      protocol:    safe.proto(r.protocol),
      length:      safe.num(r.length),
      info:        safe.str(r.info, ''),
      payload_len: safe.num(r.payload_len),
      payload_hex: typeof r.payload_hex === 'string' && r.payload_hex.length > 0 ? r.payload_hex : undefined,
      dns: r.dns != null && typeof r.dns === 'object' ? {
        is_response: !!(r.dns as Record<string,unknown>).is_response,
        questions:   safe.arr<string>((r.dns as Record<string,unknown>).questions),
        answers:     safe.arr<string>((r.dns as Record<string,unknown>).answers),
      } : undefined,
    }
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_STORED  = 10_000
const MAX_DISPLAY = 500
const FLUSH_MS    = 120

const PC: Record<Proto, { bg: string; text: string; border: string; glow: string }> = {
  TCP:     { bg: '#071e36', text: '#38bdf8', border: '#0369a1', glow: '#0ea5e9' },
  UDP:     { bg: '#160b36', text: '#a78bfa', border: '#6d28d9', glow: '#8b5cf6' },
  ARP:     { bg: '#271a00', text: '#fbbf24', border: '#b45309', glow: '#f59e0b' },
  ICMP:    { bg: '#011f16', text: '#34d399', border: '#047857', glow: '#10b981' },
  DNS:     { bg: '#150922', text: '#e879f9', border: '#9333ea', glow: '#d946ef' },
  UNKNOWN: { bg: '#0f1520', text: '#6b7280', border: '#374151', glow: '#4b5563' },
}

const ALL_PROTOS: Proto[] = ['TCP', 'UDP', 'DNS', 'ARP', 'ICMP', 'UNKNOWN']

// ── Error Boundary ────────────────────────────────────────────────────────────

class ErrorBoundary extends Component<
  { children: ReactNode; label?: string },
  { err: string | null }
> {
  state = { err: null }
  static getDerivedStateFromError(e: Error) { return { err: e.message } }
  render() {
    if (this.state.err) return (
      <div style={{ padding: '2rem', color: '#f87171', fontFamily: 'monospace', fontSize: '0.9rem' }}>
        <b>crash: {this.props.label ?? 'unknown'}</b>
        <pre style={{ marginTop: 8, color: '#6b7280', whiteSpace: 'pre-wrap', fontSize: '0.8rem' }}>
          {this.state.err}
        </pre>
        <button
          onClick={() => this.setState({ err: null })}
          style={{ marginTop: 12, background: '#1a2235', border: '1px solid #374151', color: '#e5e7eb', borderRadius: 6, padding: '6px 16px', cursor: 'pointer', fontFamily: 'inherit' }}
        >
          reset
        </button>
      </div>
    )
    return this.props.children
  }
}

// ── Batched SSE Hook ──────────────────────────────────────────────────────────
// • allRef      = permanent ring buffer (ref, never in state)
// • incoming    = accumulates raw packets between flush ticks
// • displayPkts = REAL STATE — stable slice of MAX_DISPLAY newest packets
//                 set once per flush tick, never corrupted by mid-render ref reads
// • bwRef       = rolling 2s bandwidth window (ref only, cheap setBw every tick)

function usePacketStream(url: string) {
  const allRef      = useRef<Packet[]>([])
  const incomingRef = useRef<Packet[]>([])
  const pausedRef   = useRef(false)
  const myIPRef     = useRef('')
  const bwRef       = useRef<{ ts: number; bytes: number; up: boolean }[]>([])

  // ── State ──
  const [displayPkts, setDisplayPkts] = useState<Packet[]>([])  // what the table sees
  const [allCount,    setAllCount]    = useState(0)
  const [connected,   setConnected]   = useState(false)
  const [paused,     _setPaused]      = useState(false)
  const [bw,          setBw]          = useState({ up: 0, down: 0 })

  const flush = useCallback(() => {
    const batch = incomingRef.current
    if (batch.length === 0) return
    incomingRef.current = []

    // Prepend to ring buffer
    const merged = batch.concat(allRef.current)
    if (merged.length > MAX_STORED) merged.length = MAX_STORED
    allRef.current = merged

    // Bandwidth
    const now = Date.now()
    batch.forEach(p => {
      bwRef.current.push({ ts: now, bytes: p.length, up: p.src_ip === myIPRef.current })
    })
    bwRef.current = bwRef.current.filter(b => b.ts > now - 2000)
    const w1s = bwRef.current.filter(b => b.ts > now - 1000)
    setBw({
      up:   w1s.filter(b =>  b.up).reduce((s, b) => s + b.bytes, 0),
      down: w1s.filter(b => !b.up).reduce((s, b) => s + b.bytes, 0),
    })

    if (!pausedRef.current) {
      // Take a clean snapshot into real state — avoids stale-ref corruption
      const snap = allRef.current.slice(0, MAX_DISPLAY)
      setDisplayPkts(snap)
      setAllCount(allRef.current.length)
    }
  }, [])

  const setPaused = useCallback((v: boolean) => {
    pausedRef.current = v
    _setPaused(v)
    if (!v) {
      const snap = allRef.current.slice(0, MAX_DISPLAY)
      setDisplayPkts(snap)
      setAllCount(allRef.current.length)
    }
  }, [])

  useEffect(() => {
    const es = new EventSource(url)
    es.onopen  = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (e) => {
      try {
        const raw  = JSON.parse(e.data)
        const p    = safe.packet(raw)
        if (!p) return
        // Detect own IP: campus IPs start with 137.165
        if (!myIPRef.current && p.src_ip.startsWith('137.')) {
          myIPRef.current = p.src_ip
        }
        incomingRef.current.push(p)
      } catch { /* skip malformed frames */ }
    }
    const iv = setInterval(flush, FLUSH_MS)
    return () => { es.close(); clearInterval(iv); setConnected(false) }
  }, [url, flush])

  return { displayPkts, allCount, connected, paused, setPaused, bw, myIP: myIPRef }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmtBytes = (n: number) =>
  n >= 1e6 ? `${(n/1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n/1e3).toFixed(0)} KB` : `${n} B`

const fmtRate = (n: number) =>
  n >= 1e6 ? `${(n/1e6).toFixed(1)} MB/s` : n >= 1e3 ? `${(n/1e3).toFixed(0)} KB/s` : `${n} B/s`

const fmtHex = (h: string) =>
  (h.match(/.{1,2}/g) ?? []).join(' ')

const hexToAscii = (h: string) =>
  (h.match(/.{1,2}/g) ?? [])
    .map(b => { const c = parseInt(b, 16); return c >= 32 && c < 127 ? String.fromCharCode(c) : '.' })
    .join('')

function getDomain(p: Packet): string | null {
  if (!p.dns) return null
  const q = safe.arr<string>(p.dns.questions)
  const a = safe.arr<string>(p.dns.answers)
  if (p.dns.is_response) {
    return a[0]?.split(' → ')[0] ?? q[0] ?? null
  }
  return q[0] ?? null
}

function getTime(ts: string): string {
  try { return new Date(ts).toLocaleTimeString('en-US', { hour12: false }) }
  catch { return '—' }
}

// ── Proto Badge ───────────────────────────────────────────────────────────────

function Badge({ proto, large }: { proto: Proto; large?: boolean }) {
  const c = PC[proto] ?? PC.UNKNOWN
  return (
    <span style={{
      display: 'inline-block',
      background: c.bg, color: c.text,
      border: `1.5px solid ${c.border}`,
      boxShadow: `0 0 8px ${c.glow}44`,
      padding: large ? '5px 14px' : '3px 10px',
      borderRadius: 6,
      fontSize: large ? '1rem' : '0.85rem',
      fontWeight: 800, letterSpacing: '0.07em',
      fontFamily: 'monospace',
    }}>{proto}</span>
  )
}

// ── Stat Card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent, active, onClick }: {
  label: string; value: string | number; sub?: string
  accent: string; active?: boolean; onClick?: () => void
}) {
  return (
    <div onClick={onClick} style={{
      background: active ? '#0b1d3a' : '#090e1a',
      border: `1.5px solid ${active ? accent : '#1a2235'}`,
      borderRadius: 12, padding: '1.1rem 1.4rem',
      minWidth: 110, position: 'relative', overflow: 'hidden',
      cursor: onClick ? 'pointer' : 'default', flex: '1 1 0',
      transition: 'border-color 0.15s, background 0.15s',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: accent, borderRadius: '12px 12px 0 0', boxShadow: `0 0 10px ${accent}88` }} />
      <div style={{ fontSize: '0.74rem', color: '#4b5563', letterSpacing: '0.12em', marginBottom: 10, fontFamily: 'system-ui,sans-serif', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: '2.1rem', fontWeight: 800, color: active ? '#f9fafb' : '#c9d1db', lineHeight: 1, fontFamily: 'system-ui,sans-serif' }}>{value}</div>
      {sub && <div style={{ fontSize: '0.72rem', color: '#4b5563', marginTop: 6, fontFamily: 'system-ui,sans-serif' }}>{sub}</div>}
    </div>
  )
}

// ── Bandwidth Card ────────────────────────────────────────────────────────────

function BwCard({ up, down }: { up: number; down: number }) {
  return (
    <div style={{
      background: '#090e1a', border: '1.5px solid #1a2235', borderRadius: 12,
      padding: '1.1rem 1.4rem', minWidth: 180, flex: '1 1 0', position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: 'linear-gradient(90deg,#0369a1,#9333ea)', borderRadius: '12px 12px 0 0' }} />
      <div style={{ fontSize: '0.74rem', color: '#4b5563', letterSpacing: '0.12em', marginBottom: 10, fontFamily: 'system-ui,sans-serif', textTransform: 'uppercase' }}>Throughput</div>
      <div style={{ display: 'flex', gap: '1.5rem' }}>
        <div>
          <div style={{ fontSize: '0.72rem', color: '#374151', marginBottom: 4, fontFamily: 'system-ui,sans-serif' }}>▲ up</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#38bdf8', lineHeight: 1, fontFamily: 'system-ui,sans-serif' }}>{fmtRate(up)}</div>
        </div>
        <div>
          <div style={{ fontSize: '0.72rem', color: '#374151', marginBottom: 4, fontFamily: 'system-ui,sans-serif' }}>▼ down</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#a78bfa', lineHeight: 1, fontFamily: 'system-ui,sans-serif' }}>{fmtRate(down)}</div>
        </div>
      </div>
    </div>
  )
}

// ── Packet Row ────────────────────────────────────────────────────────────────

const PacketRow = memo(function PacketRow({
  p, selected, onClick
}: { p: Packet; selected: boolean; onClick: () => void }) {
  const c      = PC[p.protocol] ?? PC.UNKNOWN
  const src    = p.src_port ? `${p.src_ip}:${p.src_port}` : p.src_ip
  const dst    = p.dst_port ? `${p.dst_ip}:${p.dst_port}` : p.dst_ip
  const time   = getTime(p.timestamp)
  const domain = getDomain(p)

  return (
    <tr
      onClick={onClick}
      style={{ borderBottom: '1px solid #0c1220', background: selected ? '#0c2040' : 'transparent', cursor: 'pointer' }}
      onMouseEnter={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = '#0a1526' }}
      onMouseLeave={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      <td style={Td}>
        <span style={{ color: '#374151', fontFamily: 'monospace', fontSize: '0.88rem' }}>{time}</span>
      </td>
      <td style={Td}>
        <span style={{
          display: 'inline-block',
          background: c.bg, color: c.text, border: `1.5px solid ${c.border}`,
          boxShadow: `0 0 8px ${c.glow}44`,
          padding: '3px 10px', borderRadius: 6,
          fontSize: '0.88rem', fontWeight: 800, letterSpacing: '0.07em', fontFamily: 'monospace',
        }}>{p.protocol}</span>
      </td>
      <td style={{ ...Td, color: '#7dd3fc', fontFamily: 'monospace', fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}>{src}</td>
      <td style={{ ...Td, color: '#1e3a5f', textAlign: 'center', width: 16 }}>›</td>
      <td style={{ ...Td, color: '#c4b5fd', fontFamily: 'monospace', fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}>{dst}</td>
      <td style={{ ...Td, color: '#374151', fontFamily: 'monospace', fontSize: '0.84rem', textAlign: 'right', paddingRight: 12 }}>{p.length}</td>
      <td style={{ ...Td, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {domain
          ? <span style={{ color: '#e879f9', fontFamily: 'monospace', fontSize: '0.9rem', fontWeight: 600 }}>{domain}</span>
          : <span style={{ color: '#4b5563', fontSize: '0.84rem' }}>{p.info}</span>
        }
      </td>
      <td style={{ ...Td, width: 60 }}>
        {p.payload_len > 0 &&
          <span style={{ background: '#1a2235', color: '#6b7280', fontSize: '0.72rem', padding: '2px 6px', borderRadius: 4, fontFamily: 'monospace' }}>
            {p.payload_len}b
          </span>
        }
      </td>
    </tr>
  )
})

// ── Payload Viewer ────────────────────────────────────────────────────────────
// Renders ONLY inside the detail panel — never inline in the table

function PayloadViewer({ hex }: { hex: string }) {
  const [view, setView] = useState<'hex' | 'ascii'>('hex')
  const [copied, setCopied] = useState(false)

  const copy = () => {
    navigator.clipboard.writeText(hex)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const content = view === 'hex' ? fmtHex(hex) : hexToAscii(hex)

  return (
    // Wrapper is a block-level div, completely separate from any table cell
    <div style={{ marginTop: '0.8rem' }}>
      {/* Controls row */}
      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.5rem', alignItems: 'center' }}>
        <span style={{ fontSize: '0.7rem', color: '#4b5563', letterSpacing: '0.1em', fontFamily: 'system-ui,sans-serif' }}>PAYLOAD</span>
        {(['hex', 'ascii'] as const).map(v => (
          <button key={v} onClick={() => setView(v)} style={SmTab(view === v)}>{v}</button>
        ))}
        <button onClick={copy} style={{ ...SmTab(false), marginLeft: 'auto', color: copied ? '#34d399' : '#4b5563' }}>
          {copied ? '✓ copied' : 'copy'}
        </button>
      </div>
      {/* Scrollable content box — fixed height, never overflows into parent */}
      <div style={{
        background: '#04070e',
        border: '1px solid #1a2235',
        borderRadius: 7,
        padding: '0.65rem 0.75rem',
        fontFamily: 'monospace',
        fontSize: '0.78rem',
        color: '#6b7280',
        height: 180,          // fixed height — no layout shifting
        overflowY: 'auto',
        overflowX: 'hidden',
        wordBreak: 'break-all',
        lineHeight: 1.8,
        whiteSpace: 'pre-wrap',
      }}>
        {content}
      </div>
    </div>
  )
}

// ── Detail Panel ──────────────────────────────────────────────────────────────

function DetailPanel({ p, onClose }: { p: Packet; onClose: () => void }) {
  const [showPayload, setShowPayload] = useState(false)
  const c = PC[p.protocol] ?? PC.UNKNOWN

  const fields: [string, string][] = [
    ['timestamp', (() => { try { return new Date(p.timestamp).toLocaleString() } catch { return p.timestamp } })()],
    ['src ip',    p.src_ip],
    ['src port',  p.src_port ? String(p.src_port) : '—'],
    ['src mac',   p.src_mac  || '—'],
    ['dst ip',    p.dst_ip],
    ['dst port',  p.dst_port ? String(p.dst_port) : '—'],
    ['dst mac',   p.dst_mac  || '—'],
    ['length',    `${p.length} bytes`],
    ['payload',   p.payload_len > 0 ? `${p.payload_len} bytes` : 'none'],
  ]

  const dnsQ = safe.arr<string>(p.dns?.questions)
  const dnsA = safe.arr<string>(p.dns?.answers)

  return (
    <div style={{
      width: 340, borderLeft: '1px solid #1a2235',
      background: '#07090e', display: 'flex', flexDirection: 'column', flexShrink: 0,
    }}>
      {/* Header */}
      <div style={{ padding: '0.9rem 1rem', borderBottom: '1px solid #1a2235', background: '#090e1a', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', minWidth: 0 }}>
          <Badge proto={p.protocol} large />
          <span style={{ fontSize: '0.82rem', color: '#9ca3af', fontFamily: 'system-ui,sans-serif', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {p.src_ip} → {p.dst_ip}
          </span>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#4b5563', cursor: 'pointer', fontSize: '1.2rem', lineHeight: 1, flexShrink: 0, marginLeft: 8 }}>✕</button>
      </div>

      {/* Scrollable body — this is a plain div, no table */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '0.9rem' }}>
        {fields.map(([label, value]) => (
          <div key={label} style={{ marginBottom: '0.8rem' }}>
            <div style={{ fontSize: '0.68rem', color: '#374151', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 3, fontFamily: 'system-ui,sans-serif' }}>{label}</div>
            <div style={{ fontSize: '0.92rem', color: '#e5e7eb', fontFamily: 'monospace', wordBreak: 'break-all' }}>{value}</div>
          </div>
        ))}

        {/* Info */}
        <div style={{ marginBottom: '0.8rem' }}>
          <div style={{ fontSize: '0.68rem', color: '#374151', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 3, fontFamily: 'system-ui,sans-serif' }}>info</div>
          <div style={{ fontSize: '0.92rem', color: '#93c5fd', fontFamily: 'monospace', wordBreak: 'break-all' }}>{p.info || '—'}</div>
        </div>

        {/* DNS block */}
        {p.dns && (
          <div style={{ background: '#0d0620', border: `1px solid ${PC.DNS.border}44`, borderRadius: 8, padding: '0.8rem', marginBottom: '0.9rem' }}>
            <div style={{ fontSize: '0.7rem', color: PC.DNS.glow, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8, fontFamily: 'system-ui,sans-serif' }}>
              DNS {p.dns.is_response ? 'Response' : 'Query'}
            </div>
            {dnsQ.map((q, i) => (
              <div key={i} style={{ fontSize: '0.9rem', color: '#e879f9', fontFamily: 'monospace', marginBottom: 5, wordBreak: 'break-all' }}>? {q}</div>
            ))}
            {dnsA.map((a, i) => (
              <div key={i} style={{ fontSize: '0.9rem', color: '#a78bfa', fontFamily: 'monospace', marginBottom: 5, wordBreak: 'break-all' }}>✓ {a}</div>
            ))}
          </div>
        )}

        {/* Payload toggle — button only, PayloadViewer expands BELOW in this same div */}
        {p.payload_hex && p.payload_len > 0 && (
          <>
            <button
              onClick={() => setShowPayload(v => !v)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                background: showPayload ? '#0c1f3c' : 'transparent',
                color: showPayload ? '#60a5fa' : '#4b5563',
                border: '1px solid #1a2235', borderRadius: 6,
                padding: '7px 12px', fontSize: '0.85rem',
                cursor: 'pointer', fontFamily: 'monospace',
              }}
            >
              {showPayload ? '▾ hide' : '▸ show'} payload ({p.payload_len} bytes)
            </button>
            {/* PayloadViewer is a sibling div — it CANNOT affect table layout */}
            {showPayload && <PayloadViewer hex={p.payload_hex} />}
          </>
        )}
      </div>

      {/* Action buttons */}
      <div style={{ padding: '0.9rem', borderTop: '1px solid #1a2235', display: 'flex', flexDirection: 'column', gap: '0.5rem', flexShrink: 0 }}>
        <button style={FutBtn} disabled>Ask LLM about this packet</button>
        <button style={FutBtn} disabled>Filter to this conversation</button>
        <button style={FutBtn} disabled>Flag as suspicious</button>
      </div>
    </div>
  )
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const { displayPkts, allCount, connected, paused, setPaused, bw, myIP } =
    usePacketStream('/api/packets')

  const [search,       setSearch]       = useState('')
  const [protoFilter,  setProtoFilter]  = useState<Proto | null>(null)
  const [selected,     setSelected]     = useState<Packet | null>(null)
  const [tab,          setTab]          = useState<'packets' | 'alerts' | 'chat'>('packets')
  const [statsVisible, setStatsVisible] = useState(true)

  const filtered = useMemo(() => {
    let r = displayPkts
    if (protoFilter) r = r.filter(p => p.protocol === protoFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      r = r.filter(p =>
        p.src_ip.includes(q) ||
        p.dst_ip.includes(q) ||
        String(p.src_port).includes(q) ||
        String(p.dst_port).includes(q) ||
        (p.src_mac ?? '').toLowerCase().includes(q) ||
        (p.dst_mac ?? '').toLowerCase().includes(q) ||
        (p.info ?? '').toLowerCase().includes(q) ||
        p.protocol.toLowerCase().includes(q) ||
        safe.arr<string>(p.dns?.questions).some(d => d.toLowerCase().includes(q)) ||
        safe.arr<string>(p.dns?.answers).some(a => a.toLowerCase().includes(q))
      )
    }
    return r
  }, [displayPkts, protoFilter, search])

  const counts = useMemo(() =>
    ALL_PROTOS.reduce((acc, p) => ({
      ...acc, [p]: displayPkts.filter(pk => pk.protocol === p).length
    }), {} as Record<Proto, number>)
  , [displayPkts])

  const bytesTotal = useMemo(() =>
    displayPkts.reduce((s, p) => s + p.length, 0)
  , [displayPkts])

  const mockAlerts = [
    { type: 'ARP Spoofing', severity: 'high'   as const, message: 'MAC changed for 192.168.1.1',   time: '--:--' },
    { type: 'Port Scan',    severity: 'medium' as const, message: '34 ports from 10.0.0.5',        time: '--:--' },
    { type: 'ICMP Flood',   severity: 'low'    as const, message: 'High ICMP from 10.0.0.12',      time: '--:--' },
  ]

  const sevColor = { high: '#ef4444', medium: '#f59e0b', low: '#6b7280' }

  return (
    <ErrorBoundary label="App">
    <div style={{
      background: '#060a12', height: '100vh', width: '100vw', overflow: 'hidden',
      color: '#e5e7eb', display: 'flex', flexDirection: 'column',
      fontFamily: '"JetBrains Mono","Cascadia Code","Fira Code",ui-monospace,monospace',
    }}>

      {/* ── Topbar ── */}
      <div style={{ height: 56, flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 1.25rem', gap: '0.9rem', borderBottom: '1px solid #111827', background: '#07090f' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
          <div style={{ width: 32, height: 32, borderRadius: 9, background: 'linear-gradient(135deg,#1d4ed8,#7c3aed)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem', fontWeight: 900, color: '#fff', fontFamily: 'system-ui,sans-serif' }}>P</div>
          <span style={{ fontWeight: 800, fontSize: '1.2rem', color: '#f9fafb', letterSpacing: '-0.03em', fontFamily: 'system-ui,sans-serif' }}>Peekr</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 12px', background: connected ? '#022c1e' : '#1c0a0a', border: `1px solid ${connected ? '#064e3b' : '#450a0a'}`, borderRadius: 20 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: connected ? '#10b981' : '#ef4444', boxShadow: `0 0 7px ${connected ? '#10b981' : '#ef4444'}` }} />
          <span style={{ fontSize: '0.8rem', color: connected ? '#34d399' : '#f87171', fontFamily: 'system-ui,sans-serif' }}>
            {connected ? 'live' : 'disconnected'}
          </span>
        </div>

        {myIP.current && (
          <span style={{ fontSize: '0.82rem', color: '#4b5563', fontFamily: 'monospace', background: '#0a0f1a', border: '1px solid #1a2235', borderRadius: 5, padding: '2px 10px' }}>
            {myIP.current}
          </span>
        )}

        <div style={{ display: 'flex', gap: 2, padding: '3px', background: '#0a0f1a', borderRadius: 9, border: '1px solid #1a2235' }}>
          {(['packets','alerts','chat'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: tab===t ? '#162040' : 'transparent', color: tab===t ? '#93c5fd' : '#4b5563',
              border: 'none', borderRadius: 7, padding: '5px 18px', fontSize: '0.86rem',
              cursor: 'pointer', fontFamily: 'system-ui,sans-serif', fontWeight: tab===t ? 600 : 400, textTransform: 'capitalize',
            }}>
              {t}
              {t==='alerts' && <span style={{ marginLeft: 6, background: '#7f1d1d', color: '#fca5a5', borderRadius: 8, padding: '0 5px', fontSize: '0.68rem' }}>3</span>}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />
        <button onClick={() => setStatsVisible(v => !v)} style={HBtn}>{statsVisible ? '▴ hide stats' : '▾ show stats'}</button>
        <button style={HBtn} disabled>Export PCAP</button>
        <button style={HBtn} disabled>Rules</button>
        <button style={{ ...HBtn, color: '#a78bfa', borderColor: '#2d1f4e' }} disabled>◈ LLM Chat</button>
      </div>

      {/* ── Stats Row ── */}
      {statsVisible && (
        <div style={{ display: 'flex', gap: '0.65rem', padding: '0.7rem 1.25rem', borderBottom: '1px solid #111827', background: '#07090f', flexShrink: 0, overflowX: 'auto' }}>
          <StatCard label="Packets" value={allCount.toLocaleString()} sub={`${filtered.length} shown`} accent="#1d4ed8" onClick={() => setProtoFilter(null)} />
          <StatCard label="Data"    value={fmtBytes(bytesTotal)} accent="#7c3aed" />
          <BwCard up={bw.up} down={bw.down} />
          {ALL_PROTOS.filter(p => p !== 'UNKNOWN').map(p => (
            <StatCard key={p} label={p} value={counts[p].toLocaleString()} accent={PC[p].border}
              active={protoFilter === p} onClick={() => setProtoFilter(protoFilter === p ? null : p)} />
          ))}
          <StatCard label="Alerts"      value="—" sub="analyzer offline" accent="#ef4444" />
          <StatCard label="Threats"     value="—" sub="analyzer offline" accent="#f59e0b" />
          <StatCard label="Gateway MAC" value="—" sub="not yet learned"  accent="#6b7280" />
        </div>
      )}

      {/* ── Body ── */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>

        {tab === 'packets' && <>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

            {/* Toolbar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', padding: '0.55rem 1rem', borderBottom: '1px solid #111827', background: '#08101a', flexShrink: 0, flexWrap: 'wrap' }}>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#374151', pointerEvents: 'none', fontSize: '1rem' }}>⌕</span>
                <input
                  type="text" placeholder="ip, port, mac, domain..." value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={{ background: '#0a0f1a', border: '1px solid #1a2235', borderRadius: 7, padding: '7px 30px 7px 28px', color: '#e5e7eb', fontSize: '0.88rem', width: 240, outline: 'none', fontFamily: 'inherit' }}
                />
                {search && (
                  <button onClick={() => setSearch('')} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#4b5563', cursor: 'pointer', fontSize: '0.85rem', padding: 0 }}>✕</button>
                )}
              </div>

              {ALL_PROTOS.map(p => {
                const c = PC[p]; const act = protoFilter === p
                return (
                  <button key={p} onClick={() => setProtoFilter(act ? null : p)} style={{
                    background: act ? c.bg : 'transparent', color: act ? c.text : '#4b5563',
                    border: `1.5px solid ${act ? c.border : '#1a2235'}`,
                    boxShadow: act ? `0 0 10px ${c.glow}44` : 'none',
                    borderRadius: 6, padding: '4px 11px', fontSize: '0.82rem',
                    fontWeight: 700, cursor: 'pointer', fontFamily: 'monospace',
                  }}>
                    {p} <span style={{ opacity: 0.5, fontWeight: 400, fontSize: '0.75rem' }}>{counts[p]}</span>
                  </button>
                )
              })}

              <div style={{ flex: 1 }} />
              <span style={{ fontSize: '0.78rem', color: '#374151', fontFamily: 'system-ui,sans-serif' }}>
                {filtered.length}/{MAX_DISPLAY} · {allCount.toLocaleString()} total
              </span>
              <button onClick={() => setPaused(!paused)} style={{
                background: paused ? '#450a0a' : '#081428', color: paused ? '#fca5a5' : '#60a5fa',
                border: `1.5px solid ${paused ? '#7f1d1d' : '#1e3a5f'}`, borderRadius: 6,
                padding: '6px 16px', fontSize: '0.86rem', cursor: 'pointer', fontFamily: 'system-ui,sans-serif', fontWeight: 600,
              }}>
                {paused ? '▶ resume' : '⏸ pause'}
              </button>
            </div>

            {paused && (
              <div style={{ background: '#1c0505', borderBottom: '1px solid #7f1d1d', padding: '0.45rem 1rem', fontSize: '0.86rem', color: '#fca5a5', display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0, fontFamily: 'system-ui,sans-serif' }}>
                ⏸ paused — still buffering in background
                <button onClick={() => setPaused(false)} style={{ marginLeft: 'auto', background: '#7f1d1d', border: 'none', color: '#fca5a5', borderRadius: 5, padding: '3px 14px', cursor: 'pointer', fontFamily: 'system-ui,sans-serif', fontSize: '0.78rem' }}>resume</button>
              </div>
            )}

            {/* Table */}
            <ErrorBoundary label="table">
              <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                  <colgroup>
                    <col style={{ width: 88 }} />
                    <col style={{ width: 98 }} />
                    <col style={{ width: 185 }} />
                    <col style={{ width: 18 }} />
                    <col style={{ width: 185 }} />
                    <col style={{ width: 56 }} />
                    <col />
                    <col style={{ width: 60 }} />
                  </colgroup>
                  <thead style={{ position: 'sticky', top: 0, background: '#08101a', zIndex: 2, borderBottom: '1px solid #111827' }}>
                    <tr>
                      {['TIME','PROTO','SOURCE','','DESTINATION','LEN','INFO / DOMAIN','DATA'].map((h,i) => (
                        <th key={i} style={{ padding: '0.5rem 0.6rem', textAlign: i===5 ? 'right' : 'left', fontSize: '0.72rem', color: '#374151', fontWeight: 500, letterSpacing: '0.1em', fontFamily: 'system-ui,sans-serif' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((p, i) => (
                      <PacketRow
                        key={i}
                        p={p}
                        selected={selected === p}
                        onClick={() => setSelected(prev => prev === p ? null : p)}
                      />
                    ))}
                  </tbody>
                </table>
                {filtered.length === 0 && (
                  <div style={{ textAlign: 'center', color: '#1f2937', padding: '5rem', fontFamily: 'system-ui,sans-serif', fontSize: '0.95rem' }}>
                    {connected ? (search || protoFilter ? 'no packets match filter' : 'waiting for packets...') : 'connecting to backend...'}
                  </div>
                )}
              </div>
            </ErrorBoundary>
          </div>

          {selected && (
            <ErrorBoundary label="detail">
              <DetailPanel p={selected} onClose={() => setSelected(null)} />
            </ErrorBoundary>
          )}
        </>}

        {tab === 'alerts' && (
          <div style={{ flex: 1, padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.65rem', overflow: 'auto' }}>
            <div style={{ fontSize: '0.75rem', color: '#374151', letterSpacing: '0.1em', fontFamily: 'system-ui,sans-serif' }}>
              ACTIVE ALERTS — analyzer.go not yet wired
            </div>
            {mockAlerts.map((a, i) => (
              <div key={i} style={{ background: '#090e1a', border: `1px solid ${sevColor[a.severity]}33`, borderLeft: `3px solid ${sevColor[a.severity]}`, borderRadius: 8, padding: '0.85rem 1.1rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: sevColor[a.severity], flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.95rem', fontWeight: 700, color: sevColor[a.severity], fontFamily: 'system-ui,sans-serif' }}>{a.type}</div>
                  <div style={{ fontSize: '0.82rem', color: '#6b7280' }}>{a.message}</div>
                </div>
                <div style={{ fontSize: '0.72rem', color: '#374151' }}>{a.time}</div>
              </div>
            ))}
            <div style={{ marginTop: 'auto', background: '#090e1a', border: '1px dashed #1a2235', borderRadius: 10, padding: '3rem', textAlign: 'center', color: '#374151', fontSize: '0.9rem', fontFamily: 'system-ui,sans-serif' }}>
              analyzer.go detectors not connected yet
            </div>
          </div>
        )}

        {tab === 'chat' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.2rem' }}>
            <div style={{ fontSize: '3.5rem', opacity: 0.15 }}>◈</div>
            <div style={{ fontSize: '1.05rem', color: '#6b7280', fontFamily: 'system-ui,sans-serif' }}>LLM chat not yet connected</div>
            <div style={{ fontSize: '0.86rem', color: '#374151', maxWidth: 360, textAlign: 'center', fontFamily: 'system-ui,sans-serif', lineHeight: 1.8 }}>
              Select packets and use "Ask LLM about this packet" in the detail panel, or connect llm.go for general network security questions.
            </div>
            <button style={{ ...FutBtn, width: 'auto', padding: '10px 24px', cursor: 'not-allowed' }} disabled>Connect LLM</button>
          </div>
        )}
      </div>

      {/* ── Status bar ── */}
      <div style={{ height: 28, flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 1.25rem', gap: '1.5rem', borderTop: '1px solid #111827', background: '#07090f', fontSize: '0.72rem', color: '#374151', fontFamily: 'system-ui,sans-serif' }}>
        {paused      && <span style={{ color: '#f87171' }}>⏸ paused</span>}
        {protoFilter && <span>proto: <span style={{ color: PC[protoFilter].text, fontFamily: 'monospace' }}>{protoFilter}</span></span>}
        {search      && <span>search: <span style={{ color: '#93c5fd', fontFamily: 'monospace' }}>{search}</span></span>}
        <span style={{ marginLeft: 'auto' }}>{allCount.toLocaleString()} / {MAX_STORED.toLocaleString()} stored · showing newest {MAX_DISPLAY}</span>
        <span>peekr v0.1</span>
      </div>
    </div>
    </ErrorBoundary>
  )
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const Td: React.CSSProperties = {
  padding: '0.34rem 0.6rem', whiteSpace: 'nowrap', overflow: 'hidden',
}

const HBtn: React.CSSProperties = {
  background: 'transparent', color: '#4b5563', border: '1px solid #1a2235',
  borderRadius: 6, padding: '5px 12px', fontSize: '0.8rem',
  cursor: 'pointer', fontFamily: 'system-ui,sans-serif',
}

const SmTab = (active: boolean): React.CSSProperties => ({
  background: active ? '#0c1f3c' : 'transparent',
  color: active ? '#60a5fa' : '#374151',
  border: `1px solid ${active ? '#1e3a5f' : '#1a2235'}`,
  borderRadius: 4, padding: '2px 8px', fontSize: '0.7rem',
  cursor: 'pointer', fontFamily: 'monospace',
})

const FutBtn: React.CSSProperties = {
  background: '#090e1a', color: '#374151', border: '1px dashed #1a2235',
  borderRadius: 7, padding: '8px 14px', fontSize: '0.86rem',
  cursor: 'not-allowed', fontFamily: 'system-ui,sans-serif',
  width: '100%', textAlign: 'left',
}