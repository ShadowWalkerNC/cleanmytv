// The device registry: every TV the app has talked to, keyed by the device itself, never by
// its address. Identity is Settings.Secure android_id (stable across reconnects and DHCP
// changes, readable over ADB without any permission); when it cannot be read, the probe's
// ro.product.device slug is the fallback. Vizio-class displays get their own provider later.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { paths } from './paths'
import { log } from './log'
import * as T from './tv'
import type { ManagedDevice } from '@shared/api'

const TASK = 'devices'

function load(): ManagedDevice[] {
  try {
    const raw = JSON.parse(readFileSync(paths.devices, 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter((d): d is ManagedDevice =>
      !!d && typeof d === 'object' && typeof (d as ManagedDevice).id === 'string')
  } catch {
    return []
  }
}

function save(devices: ManagedDevice[]): void {
  mkdirSync(paths.data, { recursive: true })
  writeFileSync(paths.devices, JSON.stringify(devices, null, 2))
}

export function listDevices(): ManagedDevice[] {
  return load().sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
}

export function getDevice(id: string): ManagedDevice | null {
  return load().find((d) => d.id === id) ?? null
}

export function removeDevice(id: string): void {
  save(load().filter((d) => d.id !== id))
  log(TASK, 'info', `forgot ${id}`)
}

/** Best-effort stable id for the connected TV. Never throws: identity must not break connect. */
async function identify(): Promise<{ id: string; androidId?: string }> {
  const probe = T.getStatus().probe
  const slug = (probe?.device ?? 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown'
  try {
    const raw = (await T.tv().shell('settings get secure android_id')).trim()
    if (/^[0-9a-f]{8,16}$/i.test(raw)) return { id: `adb-${raw.toLowerCase()}`, androidId: raw.toLowerCase() }
  } catch {
    // fall through to the slug
  }
  return { id: `adb-${slug}` }
}

/**
 * Records the connected TV in the registry (insert or refresh). Runs after every successful
 * connect; never fails the connect itself. Capabilities are filled in by a separate probe so a
 * slow TV still registers.
 */
export async function registerCurrent(capabilities: string[] = []): Promise<ManagedDevice> {
  const status = T.getStatus()
  const probe = status.probe
  if (status.state !== 'connected' || !probe) throw new Error('Connect to a TV first.')
  const { id, androidId } = await identify()
  const devices = load().map((d) => (d.state === 'connected' ? { ...d, state: 'known' as const } : d))
  const prev = devices.find((d) => d.id === id)
  const entry: ManagedDevice = {
    id,
    provider: 'adb',
    identity: {
      ...(androidId ? { androidId } : {}),
      ...(probe.device ? { device: probe.device } : {}),
      ...(probe.model ? { model: probe.model } : {}),
      ...(probe.manufacturer ? { manufacturer: probe.manufacturer } : {}),
      ...(probe.build ? { build: probe.build } : {})
    },
    capabilities: capabilities.length ? capabilities : (prev?.capabilities ?? []),
    state: 'connected',
    lastSeen: new Date().toISOString(),
    ...(status.host ? { lastAddress: status.host } : {})
  }
  save([...devices.filter((d) => d.id !== id), entry])
  log(TASK, 'info', prev ? `saw ${probe.manufacturer} ${probe.model} again as ${id}` : `registered ${probe.manufacturer} ${probe.model} as ${id}`)
  return entry
}

/** The registry entry for the connected TV, matched without touching the TV. */
export function currentDevice(): ManagedDevice | null {
  const status = T.getStatus()
  if (status.state !== 'connected') return null
  const found = load().find((d) => d.state === 'connected')
  // The address only narrows it down when the registry disagrees (see reconnect()).
  if (found && status.host && found.lastAddress && found.lastAddress !== status.host) {
    log(TASK, 'warn', `${found.id} answered at a new address (${found.lastAddress} -> ${status.host}); identity kept, address updated on next register.`)
  }
  return found ?? null
}

export function markDisconnected(): void {
  const devices = load()
  if (devices.some((d) => d.state === 'connected')) {
    save(devices.map((d) => (d.state === 'connected' ? { ...d, state: 'known' as const } : d)))
  }
}
