import { usePacketStream } from './hooks/usePacketStream'
import type { Packet } from './types'

const PROTO_COLORS: Record<string, string> = {
  TCP:     '#3b82f6',
  UDP:     '#8b5cf6',
  ARP:     '#f59e0b',
  ICMP:    '#10b981',
  UNKNOWN: '#6b7280',
}

function PacketRow({ packet }: { packet: Packet }) {
  return (
    <tr style={{ borderBottom: '1px solid #1f2937' }}>
      <td>{new Date(packet.timestamp).toLocaleTimeString()}</td>
      <td>
        <span style={{ color: PROTO_COLORS[packet.protocol], fontWeight: 600 }}>
          {packet.protocol}
        </span>
      </td>
      <td>{packet.src_ip}{packet.src_port ? `:${packet.src_port}` : ''}</td>
      <td>{packet.dst_ip}{packet.dst_port ? `:${packet.dst_port}` : ''}</td>
      <td>{packet.length}b</td>
      <td style={{ color: '#9ca3af', fontSize: '0.8rem' }}>{packet.info}</td>
    </tr>
  )
}

export default function App() {
  const { packets, connected } = usePacketStream('http://localhost:8080/api/packets')

  return (
    <div style={{ background: '#0f1117', minHeight: '100vh', color: '#e5e7eb', fontFamily: 'monospace', padding: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.2rem' }}>Peekr</h1>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: connected ? '#10b981' : '#ef4444'
        }} />
        <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>
          {connected ? 'live' : 'disconnected'}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#6b7280' }}>
          {packets.length} packets
        </span>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
        <thead>
          <tr style={{ color: '#6b7280', textAlign: 'left', borderBottom: '1px solid #374151' }}>
            <th style={{ padding: '0.25rem 0.5rem' }}>time</th>
            <th style={{ padding: '0.25rem 0.5rem' }}>proto</th>
            <th style={{ padding: '0.25rem 0.5rem' }}>src</th>
            <th style={{ padding: '0.25rem 0.5rem' }}>dst</th>
            <th style={{ padding: '0.25rem 0.5rem' }}>len</th>
            <th style={{ padding: '0.25rem 0.5rem' }}>info</th>
          </tr>
        </thead>
        <tbody>
          {packets.map((p, i) => <PacketRow key={i} packet={p} />)}
        </tbody>
      </table>

      {packets.length === 0 && (
        <div style={{ textAlign: 'center', color: '#6b7280', marginTop: '4rem' }}>
          {connected ? 'waiting for packets...' : 'connecting to backend...'}
        </div>
      )}
    </div>
  )
}