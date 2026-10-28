// The connected TV: one AdbClient, plus the helpers the upstream scripts built on top of tools/tv.py
// (probe, --batch, b64push.py for large files, base64 pulls).
import { createHash } from 'node:crypto'
import { AdbClient, AdbError } from './adb/client'
import { loadKeys } from './adb/keys'
import { log } from './log'
import type { ConnStatus, Probe } from '@shared/api'

let client: AdbClient | null = null
let status: ConnStatus = { state: 'idle' }
let keyPath = ''
let statusListener: (s: ConnStatus) => void = () => {}

export function init(appKeyPath: string, onStatus: (s: ConnStatus) => void): void {
  keyPath = appKeyPath
  statusListener = onStatus
}

function setStatus(s: ConnStatus): ConnStatus {
  status = s
  statusListener(s)
  return s
}

export function getStatus(): ConnStatus {
  return status
}

/** Lets a caller that knows more (reconnect) replace the status the window shows. */
export function report(s: ConnStatus): ConnStatus {
  return setStatus(s)
}

export async function connect(host: string): Promise<ConnStatus> {
  host = host.trim()
  disconnect()
  setStatus({ state: 'connecting', host })
  try {
    // "ip" or "ip:port"; the record and messages use the IP, as upstream's TV_HOST does.
    const m = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(host)
    if (!m || (m[2] && (Number(m[2]) < 1 || Number(m[2]) > 65535))) {
      return setStatus({ state: 'error', host, error: 'That is not an address. Type the IP the TV shows under Settings → Network, like 192.168.1.50.' })
    }
    const c = await AdbClient.connect({
      host: m[1],
      port: m[2] ? Number(m[2]) : 5555,
      keys: loadKeys(keyPath),
      onAuthPrompt: () => setStatus({ state: 'waiting-auth', host })
    })
    c.onClose = (err) => {
      if (client === c) {
        client = null
        setStatus({ state: 'error', host, error: `Lost the TV: ${err.message}` })
      }
    }
    client = c
    const probe = await readProbe(c, m[1])
    return setStatus({ state: 'connected', host, probe })
  } catch (e) {
    const err = e as AdbError
    return setStatus({ state: 'error', host, error: friendly(err), needsPairing: err.code === 'tls' })
  }
}

function friendly(err: AdbError): string {
  switch (err.code) {
    case 'refused':
      return 'The TV is there but network debugging is off. Turn on USB debugging (and Network or ADB debugging if you see it) in Developer options.'
    case 'timeout':
    case 'unreachable':
      return `${err.message} Check the IP address, that the TV is on, and that this computer is on the same network.`
    case 'tls':
      return 'This TV only offers Wireless debugging, which needs a one-time pairing code.'
    case 'auth':
      return err.message
    default:
      return err.message || String(err)
  }
}

export function disconnect(): void {
  if (client) {
    const c = client
    client = null
    c.close()
  }
  if (status.state !== 'idle') setStatus({ state: 'idle', host: status.host })
}

export function tv(): AdbClient {
  if (!client || client.closed) throw new Error('Not connected to a TV. Connect in Setup first.')
  return client
}

/** The TV's IP address, without a port. */
export function host(): string {
  if (!status.host) throw new Error('Not connected to a TV.')
  return status.host.replace(/:\d+$/, '')
}

async function readProbe(c: AdbClient, h: string): Promise<Probe> {
  const keys = ['ro.product.model', 'ro.product.device', 'ro.product.name', 'ro.product.manufacturer',
    'ro.build.version.release', 'ro.build.version.sdk', 'ro.build.display.id', 'ro.adb.secure']
  // One shell call, one line per property, so a slow TV answers in one round trip.
  const out = await c.shell(keys.map((k) => `getprop ${k}`).join('; '))
  const v = out.split('\n').map((l) => l.trim())
  return {
    host: h,
    model: v[0] ?? '',
    device: v[1] ?? '',
    product: v[2] ?? '',
    manufacturer: v[3] ?? '',
    release: v[4] ?? '',
    sdk: Number(v[5]) || 0,
    build: v[6] ?? '',
    adbSecure: v[7] ?? ''
  }
}

/** One shell command, logged under `task`. */
export async function sh(task: string, command: string, opts: { quiet?: boolean; timeoutMs?: number } = {}): Promise<string> {
  if (!opts.quiet) log(task, 'cmd', command)
  const out = await tv().shell(command, opts.timeoutMs)
  if (!opts.quiet && out.trim()) log(task, 'info', out.trimEnd())
  return out
}

/** One command per call on the same connection, as tools/tv.py --batch. */
export async function batch(task: string, commands: string[]): Promise<string[]> {
  const outs: string[] = []
  for (const c of commands) outs.push(await sh(task, c))
  return outs
}

/**
 * Upload a file as base64 chunks through plain shell commands, then check the MD5 on the TV
 * (upstream tools/b64push.py: large ADB sync pushes hang on some TVs).
 */
export async function pushB64(task: string, data: Buffer, remote: string, onChunk?: (i: number, n: number) => void): Promise<void> {
  const c = tv()
  const want = createHash('md5').update(data).digest('hex')
  // base64 of the chunk plus the echo must fit one payload; a multiple of 3 keeps '=' padding out of
  // the middle of the stream, which base64 -d would corrupt.
  let chunk = Math.min(48 * 1024, Math.floor((c.maxData * 3) / 4) - 64 - remote.length)
  chunk -= chunk % 3
  if (chunk < 3) throw new Error(`this TV accepts commands too short (${c.maxData} bytes) to upload files.`)
  const tmp = remote + '.b64'
  q(remote); q(tmp)
  await c.shell(`rm -f ${remote} ${tmp}`)
  const n = Math.max(1, Math.ceil(data.length / chunk))
  log(task, 'cmd', `upload ${remote} (${Math.round(data.length / 1024)} KB, ${n} chunks)`)
  for (let i = 0; i < n; i++) {
    const part = data.subarray(i * chunk, (i + 1) * chunk).toString('base64')
    const out = await c.shell(`echo '${part}' >> ${tmp} && echo ok${i}`, 60000)
    if (!out.includes(`ok${i}`)) throw new Error(`upload chunk ${i + 1} of ${n} failed: ${out.trim()}`)
    onChunk?.(i + 1, n)
  }
  const out = await c.shell(`base64 -d ${tmp} > ${remote} && rm ${tmp} && md5sum ${remote}`, 120000)
  const got = out.trim().split(/\s+/)[0] ?? ''
  if (got !== want) throw new Error(`upload of ${remote} is damaged (md5 ${got || 'missing'}, expected ${want}).`)
  log(task, 'ok', `uploaded ${remote}, checksum matches`)
}

/** Read a file from the TV, binary-safe: base64 on the TV, decoded here. Null when it is missing. */
export async function pullB64(remote: string): Promise<Buffer | null> {
  q(remote)
  const out = await tv().shell(`[ -f ${remote} ] && base64 ${remote} || echo __missing__`, 120000)
  if (out.includes('__missing__')) return null
  return Buffer.from(out.replace(/\s+/g, ''), 'base64')
}

/** Paths and names that go into a TV shell command: refuse anything with shell syntax. */
export function q(value: string): string {
  // A leading '-' would turn a name into an option of pm, rm or base64.
  if (!/^[A-Za-z0-9_./@:][A-Za-z0-9_./@:-]*$/.test(value)) throw new Error(`refusing unsafe name for a TV command: ${value}`)
  return value
}

export const PACKAGE_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/
export const HOME_QUERY = 'cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME'
export const HOME_CLAIMS = 'cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.HOME'
// What answers HOME without being a launcher: the setup wizards and the settings apps, kept in step
// with upstream recovery.py NOT_LAUNCHERS.
export const NOT_LAUNCHERS = ['com.google.android.tungsten.setupwraith', 'com.android.tv.settings', 'com.android.settings', 'com.android.provision']
// A vendor's FallbackHome activity, and a factory-test app: both answer HOME but neither is a home
// the viewer can use (upstream FALLBACK_HOME_RE / FACTORY_HOME_RE).
export const FALLBACK_HOME_RE = /\/[^ ]*FallbackHome$/
export const FACTORY_HOME_RE = /factorytest|factory_test|factorymode/i

/** The component that owns Home, or null (Android's chooser answers "android"). */
export async function homeComponent(): Promise<string | null> {
  const out = await tv().shell(HOME_QUERY)
  const last = out.trim().split('\n').pop()?.trim() ?? ''
  return /^[A-Za-z_][\w.]*\/[\w.$]+$/.test(last) ? last : null
}

/** What resolve-activity printed last: a component, "android" for the chooser, or "". */
export async function homeAnswer(): Promise<string> {
  const out = await tv().shell(HOME_QUERY)
  return (out.trim().split('\n').pop() ?? '').trim()
}

export async function homeClaimants(): Promise<string[]> {
  const out = await tv().shell(HOME_CLAIMS)
  const pkgs = new Set<string>()
  for (const line of out.split('\n')) {
    const m = /^\s*([A-Za-z0-9_.]+)\//.exec(line)
    if (m) pkgs.add(m[1])
  }
  return [...pkgs].sort()
}

/** Every HOME component as package/activity, as upstream home_claims prints them. */
export async function homeClaims(): Promise<string[]> {
  const out = await tv().shell(HOME_CLAIMS)
  const claims = new Set<string>()
  for (const line of out.split('\n')) {
    const m = /^\s*([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/.exec(line)
    if (m) claims.add(m[1])
  }
  return [...claims].sort()
}

/** Packages with a usable HOME activity: no FallbackHome, no factory test, no setup/settings (upstream launchers_in). */
export function launchersIn(claims: string[]): string[] {
  const pkgs = new Set<string>()
  for (const c of claims) {
    if (FALLBACK_HOME_RE.test(c)) continue
    const pkg = c.split('/')[0]
    if (FACTORY_HOME_RE.test(pkg)) continue
    if (NOT_LAUNCHERS.includes(pkg)) continue
    pkgs.add(pkg)
  }
  return [...pkgs].sort()
}

export interface HomeOwner {
  /** Package that owns Home, or '' when neither query named one. */
  pkg: string
  /** resolve-activity answered "android": Home has no default, the chooser shows. */
  chooser: boolean
}

/**
 * Who owns Home, with the pre-Nougat fallback: `cmd` only exists from Android 7, so when
 * resolve-activity names nothing package-shaped, ask the framework's mHomeProcess line, which has
 * printed the package holding Home since 4.x (upstream #795). Diagnostic text is not an owner.
 */
export async function homeOwner(): Promise<HomeOwner> {
  const ans = await homeAnswer()
  const first = ans.split('/')[0]
  const chooser = first === 'android'
  if (PACKAGE_RE.test(first)) return { pkg: first, chooser }
  let pkg = ''
  try {
    const dumpsys = await tv().shell('dumpsys activity')
    for (const line of dumpsys.split('\n')) {
      if (!line.includes('mHomeProcess:')) continue
      const m = /[: ]([A-Za-z0-9_.]+)\/[A-Za-z0-9_.]+/.exec(line)
      if (m && PACKAGE_RE.test(m[1])) { pkg = m[1]; break }
    }
  } catch {
    pkg = ''
  }
  return { pkg, chooser }
}

export async function packageSets(): Promise<{ installed: Set<string>; disabled: Set<string> }> {
  const parse = (out: string): Set<string> => new Set(out.split('\n').filter((l) => l.startsWith('package:')).map((l) => l.slice(8).trim()))
  // Every command acts on user 0, and without --user Android 14 merges every user's answer, so a
  // package only another profile disabled would be recorded as the owner's (upstream #1569). A pm
  // that does not take --user answers no package lines, and only that falls back to plain queries.
  let scope = ' --user 0'
  let installed = parse(await tv().shell('pm list packages --user 0'))
  if (!installed.size) {
    scope = ''
    installed = parse(await tv().shell('pm list packages'))
  }
  if (!installed.size) throw new Error('The TV returned no packages. Check the connection and try again.')
  const disabled = parse(await tv().shell(`pm list packages -d${scope}`))
  return { installed, disabled }
}

/** Packages among `pkgs` whose dump asks for TV_INPUT_HARDWARE, and ones the dump cannot be read for. */
export async function tvInputCheck(pkgs: string[]): Promise<{ drivers: string[]; unchecked: string[] }> {
  const names = [...new Set(pkgs)].join(' ')
  // One round trip, run on the TV: the package's own "requested permissions" block (Android 6+),
  // else its granted block, else its Service Resolver Table; "Unable to find" is not installed, and
  // NOCHK is a dump this firmware cannot be read for (upstream #321, #1753). Every name was checked
  // as a bare package name before this, so none of them can add shell syntax here.
  const out = await tv().shell(
    `for p in ${names}; do d=$(dumpsys package $p 2>/dev/null); case $d in ` +
    `*'requested permissions:'*) printf '%s\\n' "$d" | sed -n -E '/requested permissions:/,/(install|runtime) permissions:|User [0-9]+:/p' | grep -q TV_INPUT_HARDWARE && echo $p;; ` +
    `*'grantedPermissions:'*) printf '%s\\n' "$d" | sed -n -E '/grantedPermissions:/,/(install|runtime) permissions:|User [0-9]+:/p' | grep -q TV_INPUT_HARDWARE && echo $p;; ` +
    `*'Service Resolver Table:'*) printf '%s\\n' "$d" | grep -q 'android.media.tv.TvInputService' && echo $p;; ` +
    `*'Unable to find'*) :;; *) echo "NOCHK $p";; esac; done; true`)
  const inList = new Set(pkgs)
  const drivers: string[] = []
  const unchecked: string[] = []
  for (const line of out.replace(/\r/g, '').split('\n')) {
    const t = line.trim()
    if (t.startsWith('NOCHK ')) {
      const p = t.slice(6).trim()
      if (inList.has(p)) unchecked.push(p)
    } else if (inList.has(t)) {
      drivers.push(t)
    }
  }
  return { drivers, unchecked }
}

/** Which apps answer the input-switch and Settings intents (upstream handler guard). */
export async function handlerCheck(): Promise<{ inputApps: string[]; settingsApps: string[]; inconclusive: boolean }> {
  const q = 'cmd package query-activities --brief'
  // The two lists are split at the "==" line; `; true` so a firmware without a match still answers.
  const out = await tv().shell(
    `${q} -a android.intent.action.VIEW -t vnd.android.cursor.item/channel 2>/dev/null; echo ==; ` +
    `${q} -a android.settings.SETTINGS 2>/dev/null; true`)
  const lines = out.replace(/\r/g, '').split('\n')
  const sep = lines.findIndex((l) => l.trim() === '==')
  const names = (ls: string[]): string[] => {
    const s = new Set<string>()
    for (const l of ls) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+)\//.exec(l)
      if (m) s.add(m[1])
    }
    return [...s].sort()
  }
  const inputApps = names(sep < 0 ? [] : lines.slice(0, sep))
  const settingsApps = names(sep < 0 ? [] : lines.slice(sep + 1))
  // A working query always has some app answering SETTINGS; empty means the firmware has no `cmd`
  // or answered nothing at all, and the guard must say so instead of passing in silence (#1753).
  return { inputApps, settingsApps, inconclusive: settingsApps.length === 0 }
}
