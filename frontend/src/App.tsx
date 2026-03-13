import { useEffect, useRef, useState, useMemo, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

type Proto = 'TCP' | 'UDP' | 'ARP' | 'ICMP' | 'UNKNOWN'

interface Packet {
  timestamp: string
  src_ip: string
  dst_ip: string
  src_mac: string
  dst_mac: string
  src_port: number
  dst_port: number
  protocol: Proto
  length: number
  info: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_PACKETS = 10000
const PROTO_COLORS: Record<Proto, { bg: string; text: string; glow: string }> = {
  TCP:     { bg: '#0d2137', text: '#38bdf8', glow: '#0284c7' },
  UDP:     { bg: '#1e1040', text: '#a78bfa', glow: '#7c3aed' },
  ARP:     { bg: '#2d1f00', text: '#fbbf24', glow: '#d97706' },
  ICMP:    { bg: '#022c1e', text: '#34d399', glow: '#059669' },
  UNKNOWN: { bg: '#111827', text: '#6b7280', glow: '#374151' },
}
const ALL_PROTOS: Proto[] = ['TCP', 'UDP', 'ARP', 'ICMP', 'UNKNOWN']

// ── SSE Hook — pause-safe via ref ─────────────────────────────────────────────

function usePacketStream(url: string) {
  // allPackets is the source of truth — never trimmed past MAX_PACKETS
  const allPacketsRef = useRef<Packet[]>([])
  const [allPackets, setAllPackets] = useState<Packet[]>([])
  const [connected, setConnected] = useState(false)
  const pausedRef = useRef(false)
  const [paused, _setPaused] = useState(false)

  const setPaused = useCallback((v: boolean) => {
    pausedRef.current = v
    _setPaused(v)
    // On resume, flush accumulated packets to state
    if (!v) setAllPackets([...allPacketsRef.current])
  }, [])

  useEffect(() => {
    const es = new EventSource(url)
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (e) => {
      const p: Packet = JSON.parse(e.data)
      // Always accumulate to ref (even while paused)
      allPacketsRef.current = [p, ...allPacketsRef.current].slice(0, MAX_PACKETS)
      // Only push to state when not paused
      if (!pausedRef.current) {
        setAllPackets(prev => [p, ...prev].slice(0, MAX_PACKETS))
      }
    }
    return () => { es.close(); setConnected(false) }
  }, [url])

  return { allPackets, connected, paused, setPaused }
}

// ── Sparkline (mini proto bar chart) ─────────────────────────────────────────

function Sparkline({ packets }: { packets: Packet[] }) {
  const counts = useMemo(() => {
    const c: Record<Proto, number> = { TCP: 0, UDP: 0, ARP: 0, ICMP: 0, UNKNOWN: 0 }
    packets.forEach(p => c[p.protocol]++)
    return c
  }, [packets])
  const total = packets.length || 1

  return (
    <div style={{ display: 'flex', height: 4, borderRadius: 2, overflow: 'hidden', width: 120, gap: 1 }}>
      {ALL_PROTOS.map(p => counts[p] > 0 && (
        <div key={p} style={{
          width: `${(counts[p] / total) * 100}%`,
          background: PROTO_COLORS[p].glow,
          minWidth: 2,
        }} />
      ))}
    </div>
  )
}

// ── Stat Card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }: {
  label: string; value: string | number; sub?: string; accent?: string
}) {
  return (
    <div style={{
      background: '#0a0f1a',
      border: '1px solid #1a2235',
      borderRadius: 8,
      padding: '0.75rem 1rem',
      minWidth: 110,
      position: 'relative',
      overflow: 'hidden',
    }}>
      {accent && <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 2,
        background: accent,
      }} />}
      <div style={{ fontSize: '0.62rem', color: '#4b5563', letterSpacing: '0.1em', marginBottom: 4 }}>
        {label.toUpperCase()}
      </div>
      <div style={{ fontSize: '1.3rem', fontWeight: 700, color: '#f9fafb', lineHeight: 1 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: '0.65rem', color: '#6b7280', marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

// ── Alert Card (placeholder for analyzer) ────────────────────────────────────

function AlertCard({ type, severity, message, time }: {
  type: string; severity: 'high' | 'medium' | 'low'; message: string; time: string
}) {
  const colors = { high: '#ef4444', medium: '#f59e0b', low: '#6b7280' }
  const c = colors[severity]
  return (
    <div style={{
      background: '#0a0f1a',
      border: `1px solid ${c}33`,
      borderLeft: `3px solid ${c}`,
      borderRadius: 6,
      padding: '0.5rem 0.75rem',
      display: 'flex',
      alignItems: 'center',
      gap: '0.75rem',
    }}>
      <div style={{
        width: 6, height: 6, borderRadius: '50%',
        background: c, boxShadow: `0 0 6px ${c}`,
        flexShrink: 0,
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.72rem', fontWeight: 600, color: c }}>{type}</div>
        <div style={{ fontSize: '0.68rem', color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {message}
        </div>
      </div>
      <div style={{ fontSize: '0.62rem', color: '#374151', flexShrink: 0 }}>{time}</div>
    </div>
  )
}

// ── Proto Badge ───────────────────────────────────────────────────────────────

function ProtoBadge({ proto }: { proto: Proto }) {
  const c = PROTO_COLORS[proto]
  return (
    <span style={{
      background: c.bg, color: c.text,
      padding: '1px 6px', borderRadius: 3,
      fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.06em',
      border: `1px solid ${c.glow}33`,
    }}>
      {proto}
    </span>
  )
}

// ── Packet Row ────────────────────────────────────────────────────────────────

function PacketRow({ packet, selected, onClick }: {
  packet: Packet; selected: boolean; onClick: () => void
}) {
  const src = packet.src_port ? `${packet.src_ip}:${packet.src_port}` : packet.src_ip
  const dst = packet.dst_port ? `${packet.dst_ip}:${packet.dst_port}` : packet.dst_ip
  const time = new Date(packet.timestamp).toLocaleTimeString('en-US', { hour12: false })
  return (
    <tr
      onClick={onClick}
      style={{
        borderBottom: '1px solid #0f1520',
        background: selected ? '#0d1f3c' : 'transparent',
        cursor: 'pointer',
      }}
      onMouseEnter={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = '#0a1020' }}
      onMouseLeave={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      <td style={tdStyle}><span style={{ color: '#374151' }}>{time}</span></td>
      <td style={tdStyle}><ProtoBadge proto={packet.protocol} /></td>
      <td style={{ ...tdStyle, color: '#7dd3fc', fontFamily: 'monospace' }}>{src}</td>
      <td style={{ ...tdStyle, color: '#1f2937' }}>›</td>
      <td style={{ ...tdStyle, color: '#c4b5fd', fontFamily: 'monospace' }}>{dst}</td>
      <td style={{ ...tdStyle, color: '#374151' }}>{packet.length}b</td>
      <td style={{ ...tdStyle, color: '#374151', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {packet.info}
      </td>
    </tr>
  )
}

// ── Detail Drawer ─────────────────────────────────────────────────────────────

function DetailDrawer({ packet, onClose }: { packet: Packet; onClose: () => void }) {
  const rows: [string, string][] = [
    ['timestamp', new Date(packet.timestamp).toLocaleString()],
    ['protocol',  packet.protocol],
    ['src ip',    packet.src_ip],
    ['src port',  packet.src_port ? String(packet.src_port) : '—'],
    ['src mac',   packet.src_mac || '—'],
    ['dst ip',    packet.dst_ip],
    ['dst port',  packet.dst_port ? String(packet.dst_port) : '—'],
    ['dst mac',   packet.dst_mac || '—'],
    ['length',    `${packet.length} bytes`],
    ['info',      packet.info],
  ]
  return (
    <div style={{
      width: 280,
      borderLeft: '1px solid #1a2235',
      background: '#070b14',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
    }}>
      <div style={{
        padding: '0.6rem 0.75rem',
        borderBottom: '1px solid #1a2235',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span style={{ fontSize: '0.65rem', color: '#4b5563', letterSpacing: '0.1em' }}>PACKET DETAIL</span>
        <button onClick={onClose} style={{ ...ghostBtn, fontSize: '0.8rem' }}>✕</button>
      </div>
      <div style={{ padding: '0.75rem', flex: 1, overflow: 'auto' }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ marginBottom: '0.6rem' }}>
            <div style={{ fontSize: '0.6rem', color: '#374151', letterSpacing: '0.08em', marginBottom: 2 }}>
              {label.toUpperCase()}
            </div>
            <div style={{ fontSize: '0.75rem', color: '#e5e7eb', fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {value}
            </div>
          </div>
        ))}
      </div>
      <div style={{ padding: '0.75rem', borderTop: '1px solid #1a2235', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        <button style={futureBtn} disabled>Ask LLM about this packet</button>
        <button style={futureBtn} disabled>Filter to this IP</button>
        <button style={futureBtn} disabled>Show conversation</button>
      </div>
    </div>
  )
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const { allPackets, connected, paused, setPaused } = usePacketStream('/api/packets')
  const [search, setSearch]           = useState('')
  const [protoFilter, setProtoFilter] = useState<Proto | null>(null)
  const [selected, setSelected]       = useState<Packet | null>(null)
  const [activeTab, setActiveTab]     = useState<'packets' | 'alerts' | 'chat'>('packets')
  const tableBodyRef                  = useRef<HTMLDivElement>(null)

  // Improved search — tokenises and matches partial IPs properly
  const filtered = useMemo(() => {
    let result = allPackets
    if (protoFilter) result = result.filter(p => p.protocol === protoFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      result = result.filter(p =>
        p.src_ip.toLowerCase().includes(q) ||
        p.dst_ip.toLowerCase().includes(q) ||
        String(p.src_port).includes(q) ||
        String(p.dst_port).includes(q) ||
        p.src_mac.toLowerCase().includes(q) ||
        p.dst_mac.toLowerCase().includes(q) ||
        p.info.toLowerCase().includes(q) ||
        p.protocol.toLowerCase().includes(q)
      )
    }
    return result
  }, [allPackets, protoFilter, search])

  // Proto counts
  const counts = useMemo(() =>
    ALL_PROTOS.reduce((acc, p) => ({ ...acc, [p]: allPackets.filter(pk => pk.protocol === p).length }), {} as Record<Proto, number>)
  , [allPackets])

  // Bytes/sec rough estimate
  const bytesTotal = useMemo(() => allPackets.reduce((s, p) => s + p.length, 0), [allPackets])

  // Placeholder alerts
  const mockAlerts = [
    { type: 'ARP Spoofing', severity: 'high' as const,   message: 'MAC changed for 192.168.1.1',        time: '--:--' },
    { type: 'Port Scan',    severity: 'medium' as const, message: '34 ports probed from 10.0.0.5',      time: '--:--' },
    { type: 'ICMP Flood',   severity: 'low' as const,    message: 'High ICMP volume from 10.0.0.12',    time: '--:--' },
  ]

  return (
    <div style={{
      background: '#060a12',
      height: '100vh',
      width: '100vw',
      color: '#e5e7eb',
      fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", ui-monospace, monospace',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      fontSize: '0.8rem',
    }}>

      {/* ── Top bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '1rem',
        padding: '0 1rem',
        height: 44,
        borderBottom: '1px solid #111827',
        background: '#070b14',
        flexShrink: 0,
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginRight: '0.5rem' }}>
          <div style={{
            width: 22, height: 22, borderRadius: 5,
            background: 'linear-gradient(135deg, #1d4ed8, #7c3aed)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '0.65rem', fontWeight: 800, color: '#fff',
          }}>P</div>
          <span style={{ fontWeight: 700, fontSize: '0.9rem', color: '#f9fafb', letterSpacing: '-0.02em' }}>Peekr</span>
        </div>

        {/* Connection pill */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5,
          background: connected ? '#022c1e' : '#1c0a0a',
          border: `1px solid ${connected ? '#064e3b' : '#450a0a'}`,
          borderRadius: 20, padding: '2px 8px',
        }}>
          <div style={{
            width: 5, height: 5, borderRadius: '50%',
            background: connected ? '#10b981' : '#ef4444',
            boxShadow: `0 0 5px ${connected ? '#10b981' : '#ef4444'}`,
          }} />
          <span style={{ fontSize: '0.65rem', color: connected ? '#34d399' : '#f87171' }}>
            {connected ? 'live' : 'disconnected'}
          </span>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: '0.1rem', marginLeft: '0.5rem' }}>
          {(['packets', 'alerts', 'chat'] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={{
              background: activeTab === tab ? '#0f1a2e' : 'transparent',
              color: activeTab === tab ? '#93c5fd' : '#4b5563',
              border: activeTab === tab ? '1px solid #1e3a5f' : '1px solid transparent',
              borderRadius: 5, padding: '3px 10px',
              fontSize: '0.7rem', cursor: 'pointer', fontFamily: 'inherit',
              textTransform: 'capitalize',
            }}>
              {tab}
              {tab === 'alerts' && <span style={{
                marginLeft: 5, background: '#7f1d1d', color: '#fca5a5',
                borderRadius: 8, padding: '0 4px', fontSize: '0.6rem',
              }}>3</span>}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        {/* Future buttons */}
        <button style={ghostBtn} disabled title="coming soon">Export PCAP</button>
        <button style={ghostBtn} disabled title="coming soon">Rules</button>
        <button style={{ ...ghostBtn, color: '#a78bfa', borderColor: '#2d1f4e' }} disabled title="coming soon">
          LLM Chat
        </button>
      </div>

      {/* ── Stats row ── */}
      <div style={{
        display: 'flex', gap: '0.5rem', padding: '0.5rem 1rem',
        borderBottom: '1px solid #111827',
        background: '#070b14',
        flexShrink: 0,
        overflowX: 'auto',
      }}>
        <StatCard label="Packets" value={allPackets.length.toLocaleString()} sub={`${filtered.length} shown`} accent="#1d4ed8" />
        <StatCard label="Total data" value={bytesTotal > 1e6 ? `${(bytesTotal/1e6).toFixed(1)}MB` : `${(bytesTotal/1e3).toFixed(0)}KB`} accent="#7c3aed" />
        <StatCard label="TCP" value={counts.TCP.toLocaleString()} accent="#0284c7" />
        <StatCard label="UDP" value={counts.UDP.toLocaleString()} accent="#7c3aed" />
        <StatCard label="ARP" value={counts.ARP.toLocaleString()} accent="#d97706" />
        <StatCard label="ICMP" value={counts.ICMP.toLocaleString()} accent="#059669" />
        <div style={{
          background: '#0a0f1a', border: '1px solid #1a2235',
          borderRadius: 8, padding: '0.75rem 1rem',
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
          minWidth: 130,
        }}>
          <div style={{ fontSize: '0.62rem', color: '#4b5563', letterSpacing: '0.1em', marginBottom: 6 }}>PROTOCOL MIX</div>
          <Sparkline packets={allPackets} />
        </div>
        {/* Placeholder health cards */}
        <StatCard label="Alerts" value="—" sub="analyzer offline" accent="#ef4444" />
        <StatCard label="Threats" value="—" sub="analyzer offline" accent="#f59e0b" />
        <StatCard label="Gateway MAC" value="—" sub="not yet learned" accent="#6b7280" />
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>

        {activeTab === 'packets' && <>
          {/* ── Packet pane ── */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

            {/* Toolbar */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              padding: '0.4rem 0.75rem',
              borderBottom: '1px solid #111827',
              background: '#08101a',
              flexShrink: 0,
              flexWrap: 'wrap',
            }}>
              {/* Search */}
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: '#374151', fontSize: '0.7rem' }}>⌕</span>
                <input
                  type="text"
                  placeholder="ip, port, mac, protocol..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={{
                    background: '#0a0f1a', border: '1px solid #1a2235',
                    borderRadius: 5, padding: '4px 10px 4px 24px',
                    color: '#e5e7eb', fontSize: '0.72rem', width: 200,
                    outline: 'none', fontFamily: 'inherit',
                  }}
                />
                {search && (
                  <button onClick={() => setSearch('')} style={{
                    position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', color: '#4b5563', cursor: 'pointer', fontSize: '0.7rem', padding: 0,
                  }}>✕</button>
                )}
              </div>

              {/* Proto pills */}
              {ALL_PROTOS.map(p => {
                const c = PROTO_COLORS[p]
                const active = protoFilter === p
                return (
                  <button key={p} onClick={() => setProtoFilter(active ? null : p)} style={{
                    background: active ? c.bg : 'transparent',
                    color: active ? c.text : '#374151',
                    border: `1px solid ${active ? c.glow + '55' : '#1a2235'}`,
                    borderRadius: 4, padding: '2px 7px',
                    fontSize: '0.65rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                  }}>
                    {p}<span style={{ opacity: 0.5, marginLeft: 3 }}>{counts[p]}</span>
                  </button>
                )
              })}

              <div style={{ flex: 1 }} />

              <span style={{ fontSize: '0.65rem', color: '#374151' }}>
                {filtered.length.toLocaleString()} / {allPackets.length.toLocaleString()}
              </span>

              <button
                onClick={() => setPaused(!paused)}
                style={{
                  background: paused ? '#450a0a' : '#0a1428',
                  color: paused ? '#fca5a5' : '#60a5fa',
                  border: `1px solid ${paused ? '#7f1d1d' : '#1e3a5f'}`,
                  borderRadius: 4, padding: '3px 10px',
                  fontSize: '0.68rem', cursor: 'pointer', fontFamily: 'inherit',
                  fontWeight: 600,
                }}
              >
                {paused ? '▶ resume' : '⏸ pause'}
              </button>
            </div>

            {/* Paused banner */}
            {paused && (
              <div style={{
                background: '#1c0505', borderBottom: '1px solid #7f1d1d',
                padding: '0.3rem 0.75rem', fontSize: '0.68rem', color: '#fca5a5',
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                flexShrink: 0,
              }}>
                <span>⏸</span>
                <span>capture paused — packets are still buffering in the background</span>
                <button onClick={() => setPaused(false)} style={{
                  marginLeft: 'auto', background: '#7f1d1d', border: 'none', color: '#fca5a5',
                  borderRadius: 4, padding: '1px 8px', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.65rem',
                }}>resume</button>
              </div>
            )}

            {/* Table */}
            <div ref={tableBodyRef} style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
                <thead style={{ position: 'sticky', top: 0, background: '#08101a', zIndex: 1 }}>
                  <tr style={{ borderBottom: '1px solid #111827' }}>
                    {['time', 'proto', 'source', '', 'destination', 'len', 'info'].map((h, i) => (
                      <th key={i} style={{
                        ...tdStyle, color: '#374151', fontWeight: 500,
                        textAlign: 'left', fontSize: '0.62rem', letterSpacing: '0.08em',
                        padding: '0.35rem 0.5rem',
                      }}>
                        {h.toUpperCase()}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p, i) => (
                    <PacketRow
                      key={i} packet={p}
                      selected={selected === p}
                      onClick={() => setSelected(selected === p ? null : p)}
                    />
                  ))}
                </tbody>
              </table>
              {filtered.length === 0 && (
                <div style={{ textAlign: 'center', color: '#1f2937', padding: '4rem', fontSize: '0.75rem' }}>
                  {connected
                    ? search || protoFilter ? 'no packets match filter' : 'waiting for packets...'
                    : 'connecting to backend at localhost:8080...'}
                </div>
              )}
            </div>
          </div>

          {/* Detail drawer */}
          {selected && <DetailDrawer packet={selected} onClose={() => setSelected(null)} />}
        </>}

        {activeTab === 'alerts' && (
          <div style={{ flex: 1, padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', overflow: 'auto' }}>
            <div style={{ fontSize: '0.65rem', color: '#374151', letterSpacing: '0.1em', marginBottom: '0.25rem' }}>
              ACTIVE ALERTS — analyzer not yet connected, showing placeholder data
            </div>
            {mockAlerts.map((a, i) => <AlertCard key={i} {...a} />)}
            <div style={{
              marginTop: 'auto', background: '#0a0f1a', border: '1px dashed #1a2235',
              borderRadius: 8, padding: '2rem', textAlign: 'center', color: '#374151', fontSize: '0.72rem',
            }}>
              analyzer.go not yet wired — alerts will appear here once connected
            </div>
          </div>
        )}

        {activeTab === 'chat' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem', color: '#374151' }}>
            <div style={{ fontSize: '2rem' }}>◈</div>
            <div style={{ fontSize: '0.8rem' }}>LLM chat not yet connected</div>
            <div style={{ fontSize: '0.68rem', color: '#1f2937', maxWidth: 300, textAlign: 'center' }}>
              Select packets in the packets tab and click "Ask LLM about this packet",
              or use the LLM Chat button in the header for a general network conversation.
            </div>
            <button style={{ ...futureBtn, opacity: 1, cursor: 'not-allowed' }} disabled>
              Connect LLM
            </button>
          </div>
        )}
      </div>

      {/* ── Status bar ── */}
      <div style={{
        height: 24, display: 'flex', alignItems: 'center',
        padding: '0 1rem', gap: '1.5rem',
        borderTop: '1px solid #111827',
        background: '#070b14',
        fontSize: '0.62rem', color: '#374151',
        flexShrink: 0,
      }}>
        {paused && <span style={{ color: '#f87171' }}>⏸ paused</span>}
        {protoFilter && <span>proto: <span style={{ color: PROTO_COLORS[protoFilter].text }}>{protoFilter}</span></span>}
        {search && <span>search: <span style={{ color: '#93c5fd' }}>{search}</span></span>}
        <span style={{ marginLeft: 'auto' }}>
          {allPackets.length.toLocaleString()} / {MAX_PACKETS.toLocaleString()} packets stored
        </span>
        <span>peekr v0.1</span>
      </div>
    </div>
  )
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const tdStyle: React.CSSProperties = {
  padding: '0.28rem 0.5rem',
  whiteSpace: 'nowrap',
}

const ghostBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#4b5563',
  border: '1px solid #1a2235',
  borderRadius: 4, padding: '3px 8px',
  fontSize: '0.65rem', cursor: 'pointer', fontFamily: 'inherit',
}

const futureBtn: React.CSSProperties = {
  background: '#0a0f1a',
  color: '#374151',
  border: '1px dashed #1a2235',
  borderRadius: 5, padding: '5px 12px',
  fontSize: '0.7rem', cursor: 'not-allowed', fontFamily: 'inherit',
  width: '100%', textAlign: 'left',
}