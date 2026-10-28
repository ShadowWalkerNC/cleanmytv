// Find TVs: every address on this computer's local /24 networks with port 5555 open.
import { Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import { listDevices } from './devices'
import type { ManagedDevice, ScanHit } from '@shared/api'

export function localSubnets(): string[] {
  const out = new Set<string>()
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      // Private ranges only; a /24 around this address is where a home TV sits.
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue
      out.add(a.address.split('.').slice(0, 3).join('.'))
    }
  }
  return [...out]
}

function probe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new Socket()
    const done = (open: boolean): void => { s.destroy(); resolve(open) }
    s.setTimeout(timeoutMs)
    s.once('connect', () => done(true))
    s.once('timeout', () => done(false))
    s.once('error', () => done(false))
    s.connect(port, host)
  })
}

export async function scan(port = 5555): Promise<ScanHit[]> {
  const hosts = localSubnets().flatMap((net) => Array.from({ length: 254 }, (_, i) => `${net}.${i + 1}`))
  const hits: ScanHit[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < hosts.length) {
      const h = hosts[next++]
      if (await probe(h, port, 600)) hits.push({ host: h })
    }
  }
  await Promise.all(Array.from({ length: 96 }, worker))
  return nameHits(
    hits.sort((a, b) => Number(a.host.split('.')[3]) - Number(b.host.split('.')[3])),
    listDevices()
  )
}

/** Label hits from the registry by last-seen address. Pure: the sweep itself stays untestable. */
export function nameHits(hits: ScanHit[], devices: ManagedDevice[]): ScanHit[] {
  const byAddr = new Map<string, ManagedDevice>()
  for (const d of devices) {
    if (d.lastAddress) byAddr.set(d.lastAddress.replace(/:\d+$/, ''), d)
  }
  return hits.map((h) => {
    const d = byAddr.get(h.host)
    if (!d) return h
    const maker = d.identity.manufacturer ?? ''
    const model = d.identity.model ?? ''
    const name = (maker && model.toLowerCase().startsWith(maker.toLowerCase()) ? model : [maker, model].filter(Boolean).join(' ')) || d.id
    return { ...h, name }
  })
}
