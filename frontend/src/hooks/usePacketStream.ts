import { useEffect, useRef, useState } from 'react'
import type { Packet } from '../types'

const MAX_PACKETS = 500 // cap so the table doesn't grow forever

export function usePacketStream(url: string) {
  const [packets, setPackets] = useState<Packet[]>([])
  const [connected, setConnected] = useState(false)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    const es = new EventSource(url)
    esRef.current = es

    es.onopen = () => setConnected(true)

    es.onmessage = (e) => {
      const packet: Packet = JSON.parse(e.data)
      setPackets(prev => [packet, ...prev].slice(0, MAX_PACKETS))
    }

    es.onerror = () => setConnected(false)

    return () => {
      es.close()
      setConnected(false)
    }
  }, [url])

  return { packets, connected }
}