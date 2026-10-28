// The Recovery Center: named restorable snapshots of a TV's software state - package states,
// Home, theme, DNS, animations, screensaver, launcher. This is settings plus app states, NOT a
// firmware backup: it cannot revive a TV that does not boot, and it never claims to.
// Snapshots replay through the same typed operations as the app screens (never raw shell paste),
// and a snapshot restores only onto the device it was taken from.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './paths'
import { log } from './log'
import * as T from './tv'
import { HOME_RE, KNOWN_STOCK_LAUNCHERS, strftimeNow, type RecoveryRecord } from './debloat'
import { PKG, status as launcherStatus } from './launcher'
import { animationScale, clockScreensaver, privateDns } from './system'
import { apply as applyTheme, read as readTheme } from './theme'
import { currentDevice } from './devices'
import type { ApplyResult, LauncherConfig, SnapshotDiff, SnapshotSummary } from '@shared/api'

const TASK = 'recovery'

type PkgState = 'enabled' | 'disabled'

interface SnapshotData {
  manifest: { id: string; created: string; deviceId: string; label: string; coverage: string[] }
  packages: Record<string, PkgState>
  home: string | null
  stock: string
  settings: Record<string, string>
  theme: { present: boolean; config: LauncherConfig; wallpaper: string | null; wallpapers: string[] }
  launcher: { installed: boolean; versionName?: string; isHome: boolean }
}

const SETTING_GETS: Array<[string, string]> = [
  ['global', 'window_animation_scale'],
  ['global', 'transition_animation_scale'],
  ['global', 'animator_duration_scale'],
  ['secure', 'screensaver_components'],
  ['secure', 'screensaver_enabled'],
  ['global', 'private_dns_mode'],
  ['global', 'private_dns_specifier']
]

function snapDir(deviceId: string, id: string): string {
  return join(paths.recovery, deviceId, id)
}

function readData(deviceId: string, id: string): SnapshotData {
  const raw = JSON.parse(readFileSync(join(snapDir(deviceId, id), 'data.json'), 'utf8')) as SnapshotData
  if (!raw || typeof raw !== 'object' || !raw.manifest || typeof raw.packages !== 'object') {
    throw new Error(`snapshot ${id} is damaged; delete it deliberately.`)
  }
  return raw
}

function findSnapshot(id: string): { deviceId: string; data: SnapshotData } {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`not a snapshot id: ${id}`)
  if (!existsSync(paths.recovery)) throw new Error(`no such snapshot: ${id}`)
  for (const deviceId of readdirSync(paths.recovery)) {
    const file = join(snapDir(deviceId, id), 'data.json')
    if (existsSync(file)) return { deviceId, data: readData(deviceId, id) }
  }
  throw new Error(`no such snapshot: ${id}`)
}

function summarize(deviceId: string, data: SnapshotData): SnapshotSummary {
  return {
    id: data.manifest.id,
    created: data.manifest.created,
    deviceId,
    label: data.manifest.label,
    coverage: data.manifest.coverage,
    packages: Object.keys(data.packages).length
  }
}

export function listSnapshots(deviceId?: string): SnapshotSummary[] {
  if (!existsSync(paths.recovery)) return []
  const out: SnapshotSummary[] = []
  for (const dev of readdirSync(paths.recovery).sort()) {
    if (deviceId && dev !== deviceId) continue
    for (const id of readdirSync(join(paths.recovery, dev)).sort()) {
      try {
        out.push(summarize(dev, readData(dev, id)))
      } catch {
        // A damaged snapshot never hides the healthy ones; delete it from the screen.
      }
    }
  }
  return out.sort((a, b) => b.created.localeCompare(a.created))
}

export async function createSnapshot(label: string): Promise<SnapshotSummary> {
  const probe = T.getStatus().probe
  if (!probe) throw new Error('Connect to a TV first.')
  const device = currentDevice()
  if (!device) throw new Error('This TV is not in the device registry yet. Reconnect once, then try again.')
  const clean = label.trim().slice(0, 60) || 'snapshot'
  const id = `${strftimeNow().replace(/[-: ]/g, (c) => (c === ' ' ? '-' : ''))}-${clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'snapshot'}`
  const { installed, disabled } = await T.packageSets()
  const packages: Record<string, PkgState> = {}
  for (const p of installed) packages[p] = disabled.has(p) ? 'disabled' : 'enabled'
  const home = await T.homeComponent()
  const stock = KNOWN_STOCK_LAUNCHERS.find((n) => installed.has(n)) ?? KNOWN_STOCK_LAUNCHERS[0]
  const settings: Record<string, string> = {}
  for (const [ns, key] of SETTING_GETS) settings[`${ns} ${key}`] = (await T.tv().shell(`settings get ${ns} ${key}`)).trim()
  const theme = await readTheme()
  const launcher = await launcherStatus()
  const data: SnapshotData = {
    manifest: {
      id,
      created: strftimeNow(),
      deviceId: device.id,
      label: clean,
      coverage: ['packages', 'home', 'theme', 'dns', 'animations', 'screensaver', 'launcher']
    },
    packages,
    home,
    stock,
    settings,
    theme: { present: theme.present, config: theme.config, wallpaper: theme.wallpaper, wallpapers: theme.wallpapers },
    launcher: { installed: launcher.installed, ...(launcher.versionName ? { versionName: launcher.versionName } : {}), isHome: launcher.isHome }
  }
  mkdirSync(snapDir(device.id, id), { recursive: true })
  writeFileSync(join(snapDir(device.id, id), 'data.json'), JSON.stringify(data, null, 2))
  log(TASK, 'ok', `snapshot ${id}: ${Object.keys(packages).length} packages, Home ${home ?? 'none recorded'}`)
  return summarize(device.id, data)
}

/** Values replayed onto the shell: fixed keys, and values without shell syntax. */
function safeSetting(value: string): boolean {
  return /^[A-Za-z0-9_.:/=+@-]*$/.test(value) && !value.includes('..')
}

export async function restoreSnapshot(id: string): Promise<ApplyResult> {
  const probe = T.getStatus().probe
  if (!probe) throw new Error('Connect to a TV first.')
  const { deviceId, data } = findSnapshot(id)
  const current = currentDevice()
  if (!current || current.id !== deviceId) {
    throw new Error(`Snapshot ${id} was taken from ${deviceId}; this TV is ${current?.id ?? 'unregistered'}. Snapshots restore only onto their own TV.`)
  }
  const notes: string[] = []
  let failures = 0
  const { installed } = await T.packageSets()

  // Packages: back to the recorded states. Absent ones are skipped, never resurrected.
  for (const [pkg, state] of Object.entries(data.packages)) {
    if (!T.PACKAGE_RE.test(pkg)) {
      notes.push(`Skipped ${pkg}: not a package name in the snapshot.`)
      failures++
      continue
    }
    if (!installed.has(pkg)) {
      notes.push(`Skipped ${pkg}: no longer installed.`)
      continue
    }
    const out = await T.sh(TASK, state === 'enabled' ? `pm enable ${pkg}` : `pm disable-user --user 0 ${pkg}`)
    if (!new RegExp(state === 'enabled' ? 'enabled' : 'disabled', 'i').test(out)) {
      notes.push(`${pkg}: the TV did not confirm; check it in the Apps list.`)
      failures++
    }
  }

  // Home: recorded component, else the stock launcher that was installed then.
  if (data.home && HOME_RE.test(data.home)) {
    await T.sh(TASK, `cmd package set-home-activity --user 0 ${data.home}`)
  } else if (installed.has(data.stock)) {
    await T.sh(TASK, `cmd package set-home-activity --user 0 ${data.stock}`)
    notes.push(`No Home was recorded; Home goes to ${data.stock}.`)
  } else {
    notes.push('No Home was recorded and the stock launcher is gone; Home was left alone.')
  }

  // Settings: animation scales, screensaver, DNS hosts. 'null' means unset: delete, not put.
  for (const [key, value] of Object.entries(data.settings)) {
    const [ns, name] = key.split(' ')
    if (!['global', 'secure'].includes(ns) || !/^[a-z_]+$/.test(name ?? '') || !safeSetting(value)) {
      notes.push(`Skipped ${key}: not replayable from the snapshot.`)
      failures++
      continue
    }
    await T.sh(TASK, value === 'null' || value === '' ? `settings delete ${ns} ${name}` : `settings put ${ns} ${name} ${value}`)
  }

  // Theme: config plus wallpaper back, rotation sets untouched (only listed, not stored).
  try {
    const wallpaper = data.theme.wallpaper
    await applyTheme({
      config: data.theme.config,
      wallpaper: wallpaper && wallpaper.includes(',') ? { kind: 'set', image: { name: 'wallpaper.jpg', base64: wallpaper.slice(wallpaper.indexOf(',') + 1) } } : { kind: 'remove' },
      wallpapers: { kind: 'keep' }
    })
  } catch (e) {
    notes.push(`Theme: ${(e as Error).message}`)
    failures++
  }

  // DNS mode/host, screensaver, animations through the same typed calls as the screens.
  try {
    const mode = data.settings['global private_dns_mode']
    const host = data.settings['global private_dns_specifier']
    const r = await privateDns(mode === 'hostname' && host && host !== 'null' ? host : null)
    if (!r.ok) { notes.push(`DNS: ${r.summary}`); failures++ }
  } catch (e) {
    notes.push(`DNS: ${(e as Error).message}`)
    failures++
  }
  try {
    const r = await clockScreensaver((data.settings['secure screensaver_components'] ?? '').includes(`${PKG}/.ClockDream`))
    if (!r.ok) { notes.push(`Screensaver: ${r.summary}`); failures++ }
  } catch (e) {
    notes.push(`Screensaver: ${(e as Error).message}`)
    failures++
  }
  const scale = Number(data.settings['global window_animation_scale'])
  if ([0, 0.5, 1].includes(scale)) {
    try {
      const r = await animationScale(scale as 0 | 0.5 | 1)
      if (!r.ok) { notes.push(`Animations: ${r.summary}`); failures++ }
    } catch (e) {
      notes.push(`Animations: ${(e as Error).message}`)
      failures++
    }
  }

  if (data.launcher.installed && !installed.has(PKG)) {
    notes.push('The clean launcher was installed at snapshot time and is gone now; reinstall it from the Launcher step.')
  }
  log(TASK, failures ? 'warn' : 'ok', `restored ${id} with ${failures} problem${failures === 1 ? '' : 's'}`)
  return { ok: failures === 0, summary: failures ? `Restored ${id} with ${failures} problem${failures === 1 ? '' : 's'}.` : `Restored ${id}.`, warnings: notes }
}

/**
 * The automatic recovery point: one per quarter hour no matter the context, so a Fix that also
 * debloats must not leave near-identical snapshots. Returns null when the TV is not registered
 * (logged, never thrown): callers treat that as "no safety net" in their own warnings, while the
 * debloat record and transaction rollbacks still hold.
 */
export async function autoSnapshot(context: string): Promise<SnapshotSummary | null> {
  const device = currentDevice()
  if (!device) {
    log(TASK, 'info', 'auto snapshot skipped: this TV is not in the registry')
    return null
  }
  const recent = listSnapshots(device.id).find((s) => {
    const taken = Date.parse(s.created.replace(' ', 'T'))
    return s.label.startsWith('auto ') && !Number.isNaN(taken) && Date.now() - taken < 15 * 60 * 1000
  })
  if (recent) {
    log(TASK, 'info', `reusing automatic snapshot ${recent.id}`)
    return recent
  }
  return createSnapshot(`auto ${context}`)
}

export function deleteSnapshot(id: string): void {
  const { deviceId } = findSnapshot(id)
  rmSync(snapDir(deviceId, id), { recursive: true, force: true })
  log(TASK, 'info', `deleted snapshot ${id}`)
}

export function diffSnapshots(a: string, b: string): SnapshotDiff {
  const older = findSnapshot(a).data
  const newer = findSnapshot(b).data
  const pkgs = new Set([...Object.keys(older.packages), ...Object.keys(newer.packages)])
  const packagesChanged: SnapshotDiff['packagesChanged'] = []
  for (const pkg of [...pkgs].sort()) {
    const from = older.packages[pkg] ?? 'absent'
    const to = newer.packages[pkg] ?? 'absent'
    if (from !== to) packagesChanged.push({ pkg, from, to })
  }
  const keys = new Set([...Object.keys(older.settings), ...Object.keys(newer.settings)])
  const settingsChanged: SnapshotDiff['settingsChanged'] = []
  for (const key of [...keys].sort()) {
    const from = older.settings[key] ?? 'absent'
    const to = newer.settings[key] ?? 'absent'
    if (from !== to) settingsChanged.push({ key, from, to })
  }
  return {
    a,
    b,
    packagesChanged,
    homeChanged: older.home === newer.home ? null : { from: older.home, to: newer.home },
    settingsChanged,
    themeChanged: JSON.stringify(older.theme.config) !== JSON.stringify(newer.theme.config) ||
      (older.theme.wallpaper ? 'set' : 'none') !== (newer.theme.wallpaper ? 'set' : 'none')
  }
}

/** A debloat-shaped record view of a snapshot, for tooling that already reads records. */
export function asRecoveryRecord(deviceId: string, id: string): RecoveryRecord {
  const data = readData(deviceId, id)
  return {
    version: 1,
    created: data.manifest.created,
    host: deviceId,
    list: `snapshot:${id}`,
    home: data.home,
    settings: {
      window_animation_scale: data.settings['global window_animation_scale'] ?? 'null',
      transition_animation_scale: data.settings['global transition_animation_scale'] ?? 'null',
      animator_duration_scale: data.settings['global animator_duration_scale'] ?? 'null'
    },
    packages: { ...data.packages },
    device: deviceId
  }
}
