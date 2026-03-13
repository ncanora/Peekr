export interface Packet {
  timestamp: string
  src_ip: string
  dst_ip: string
  src_mac: string
  dst_mac: string
  src_port: number
  dst_port: number
  protocol: 'TCP' | 'UDP' | 'ARP' | 'ICMP' | 'UNKNOWN'
  length: number
  info: string
}