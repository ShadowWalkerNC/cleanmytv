// Debloat lists, the recovery record and disable/restore: the TypeScript port of upstream
// tools/disable.sh, tools/recovery.py and tools/restore.sh, with the same guards and the same record
// format in ~/.cleanyourtv/, so either tool can undo what the other did.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { paths } from './paths'
import { log } from './log'
import { runTx } from './tx'
import { autoSnapshot } from './recovery'
import * as T from './tv'
import type { ApplyResult, DebloatApplyRequest, DebloatEntry, DebloatListSummary, DebloatPlan, PackageState, Probe } from '@shared/api'

const TASK = 'debloat'
export const SETUPWRAITH = 'com.google.android.tungsten.setupwraith'
export const KNOWN_STOCK_LAUNCHERS = ['com.google.android.tvlauncher', 'com.google.android.apps.tv.launcherx', 'com.google.android.leanbacklauncher', 'com.mitv.tvhome']
const CUSTOM_LAUNCHER = 'com.gathin.tvhome'
const SETTINGS = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'] as const
export const HOME_RE = /^[A-Za-z_][\w.]*\/[\w.$]+$/
const SCALE_RE = /^-?\d+(\.\d+)?$/
const VERSION = 1

// Core Android packages no list may disable: with one of these off, Android itself can stop booting
// (upstream #884: a Mi TV Stick that lost its permission controller, package installer, ext services,
// module metadata and mainline overlays never came back; #1578: a Haier looped with its TV middleware
// off). The content providers in CORE_OK are the exception, since tested lists turn them off and no
// TV feature uses them. Kept in step with upstream recovery.py CORE_RE/CORE_OK.
const CORE_RE = /^(android|android\.ext\.(services|shared)|com\.android\.systemui|com\.android\.shell|com\.android\.phone|com\.android\.settings|com\.android\.tv\.settings|com\.(google\.)?android\.(permissioncontroller|packageinstaller|ext\.services|ext\.shared|modulemetadata)|com\.google\.android\.overlay\.modules.*|com\.android\.providers\..*|com\.cltv\.mal|com\.mediatek\.(tis|tv\.service|tv\.agent))$/
const CORE_OK = /^com\.android\.providers\.(calendar|contacts|userdictionary|blockednumber)$/

/** The names that must never be disabled, in list order (upstream recovery.core_packages). */
export function corePackages(names: string[]): string[] {
  return names.filter((n) => CORE_RE.test(n) && !CORE_OK.test(n))
}

/** Whether a Home component is Android's chooser rather than a launcher (upstream is_chooser). */
export function isChooser(home: string | null): boolean {
  return !!home && !T.PACKAGE_RE.test(home.split('/')[0])
}

/** Whether a Home component answers HOME without being a launcher to put back (upstream not_a_launcher). */
export function notALauncher(home: string | null): boolean {
  if (!home) return false
  const pkg = home.split('/')[0]
  return T.NOT_LAUNCHERS.includes(pkg) || T.FALLBACK_HOME_RE.test(home) || T.FACTORY_HOME_RE.test(pkg)
}

// ---- lists ---------------------------------------------------------------------------------------

export interface ListEntry {
  pkg: string
  note: string
  suggested: boolean
  /** The comment heading the block the package sits in, e.g. "Personal choice: voice assistant". */
  section?: string
}

export interface ParsedList {
  header: string[]
  entries: ListEntry[]
}

/**
 * A debloat list: active lines are package names with an optional "# note"; a commented-out line
 * holding only a package (and a note) is one the author chose to keep. A BOM and CRLF are dropped.
 * Anything else on an active line refuses the whole list, as recovery.py does.
 */
export function parseList(text: string, name = 'list'): ParsedList {
  const header: string[] = []
  const entries: ListEntry[] = []
  const seen = new Set<string>()
  // A blank line ends a block; the last comment line that is not a package heads the block.
  let section: string | undefined
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  lines.forEach((raw, i) => {
    const line = raw.trim()
    if (!line) { section = undefined; return }
    if (line.startsWith('#')) {
      const body = line.replace(/^#+\s*/, '')
      const m = /^(\S+)\s*(?:#\s*(.*))?$/.exec(body)
      if (m && T.PACKAGE_RE.test(m[1])) {
        if (!seen.has(m[1])) { seen.add(m[1]); entries.push({ pkg: m[1], note: (m[2] ?? '').trim(), suggested: false, section }) }
      } else {
        if (!entries.length) header.push(body)
        if (body) section = body
      }
      return
    }
    const hash = line.indexOf('#')
    const code = (hash >= 0 ? line.slice(0, hash) : line).trim()
    const note = hash >= 0 ? line.slice(hash + 1).trim() : ''
    const pkg = code.split(/\s+/)[0]
    if (!T.PACKAGE_RE.test(pkg)) throw new Error(`${name}:${i + 1}: not a package name: ${pkg}`)
    const existing = entries.find((e) => e.pkg === pkg)
    if (existing) { existing.suggested = true; return }
    seen.add(pkg)
    entries.push({ pkg, note, suggested: true, section })
  })
  return { header, entries }
}

interface Upstream {
  id: string
  title: string
  text: string
  parsed: ParsedList
}

let upstreamCache: Upstream[] | null = null

function upstreamLists(): Upstream[] {
  if (upstreamCache) return upstreamCache
  const out: Upstream[] = []
  if (existsSync(paths.examples)) {
    for (const id of readdirSync(paths.examples).sort()) {
      const file = join(paths.examples, id, 'debloat.txt')
      if (!existsSync(file)) continue
      try {
        const text = readFileSync(file, 'utf8')
        const parsed = parseList(text, `${id}/debloat.txt`)
        out.push({ id, title: parsed.header[0] ?? id, text, parsed })
      } catch (e) {
        log(TASK, 'warn', `skipping upstream list ${id}: ${(e as Error).message}`)
      }
    }
  }
  upstreamCache = out
  return out
}

/** How many upstream lists disable each package, and the first note found for it. */
function commonality(): Map<string, { count: number; note: string }> {
  const m = new Map<string, { count: number; note: string }>()
  for (const l of upstreamLists()) {
    for (const e of l.parsed.entries) {
      if (!e.suggested) continue
      const cur = m.get(e.pkg) ?? { count: 0, note: '' }
      cur.count++
      if (!cur.note && e.note) cur.note = e.note
      m.set(e.pkg, cur)
    }
  }
  return m
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** How well a list's header and folder name fit the TV's properties. */
export function matchScore(id: string, header: string[], probe: Pick<Probe, 'model' | 'device' | 'product' | 'manufacturer'>): number {
  const text = (header.slice(0, 4).join(' ') + ' ' + id).toLowerCase()
  const has = (token: string): boolean => {
    const t = token.trim().toLowerCase()
    if (t.length < 3) return false
    return new RegExp(`(^|[^a-z0-9])${escapeRe(t)}([^a-z0-9]|$)`).test(text)
  }
  let score = 0
  if (has(probe.device)) score += 5
  if (has(probe.model)) score += 4
  if (probe.product && probe.product !== probe.device && has(probe.product)) score += 3
  const brand = probe.manufacturer.trim().toLowerCase().split(/\s+/)[0]
  if (score && brand && id.startsWith(brand)) score += 1
  return score
}

export function lists(probe: Probe | undefined): DebloatListSummary[] {
  const all = upstreamLists().map((l) => ({
    id: l.id,
    title: l.title,
    score: probe ? matchScore(l.id, l.parsed.header, probe) : 0
  }))
  all.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  const out: DebloatListSummary[] = [...all]
  // Device-family fallback (#2): when no list matches the TV on model/device (best exact score
  // < 5), infer one from the manufacturer so unlisted models of a known family still start from
  // that family's list instead of the generic one. The entry keeps the base list's id (so
  // selecting it loads the real list) and is clearly marked as inferred.
  const bestExact = all[0]?.score ?? 0
  if (probe && bestExact < 5) {
    const family = familyFor(probe)
    const base = family ? upstreamLists().find((l) => l.id === family.baseListId) : undefined
    if (family && base && !all.some((l) => l.id === base.id && l.score >= 5)) {
      out.push({
        id: base.id,
        title: `Inferred for your ${family.label} device — review each package`,
        score: 0
      })
    }
  }
  return [{ id: 'custom', title: 'My TV is not listed: pick from packages other TVs disable', score: 0 }, ...out]
}

/**
 * Known device families: maps a TV's manufacturer (and model-code prefix) to the upstream list
 * that best represents the family. Real owner reports can promote an inferred match into a
 * dedicated upstream list over time; keep this list small and evidence-based.
 */
const DEVICE_FAMILIES: Array<{ label: string; manufacturers: string[]; modelPrefixes: string[]; baseListId: string }> = [
  { label: 'Xiaomi / Mi TV', manufacturers: ['xiaomi', 'redmi'], modelPrefixes: ['mitv', 'mssp', 'mftr'], baseListId: 'xiaomi-mitv-mssp3' },
  { label: 'TCL', manufacturers: ['tcl', 'thomson'], modelPrefixes: [], baseListId: 'tcl-c755-google-tv' }
]

function familyFor(probe: Pick<Probe, 'model' | 'device' | 'product' | 'manufacturer'>): { label: string; baseListId: string } | null {
  const brand = probe.manufacturer.trim().toLowerCase().split(/\s+/)[0]
  const model = probe.model.trim().toLowerCase()
  for (const f of DEVICE_FAMILIES) {
    const mfrHit = brand && f.manufacturers.some((m) => brand === m || brand.includes(m))
    const modelHit = model && f.modelPrefixes.some((p) => model.startsWith(p))
    if (mfrHit || modelHit) return { label: f.label, baseListId: f.baseListId }
  }
  return null
}

// ---- the saved list and its recovery record -------------------------------------------------------

const cytvDir = (): string => join(homedir(), '.cleanyourtv')

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'tv'
}

/** The list this app writes for the TV and hands to the record, like a user's own debloat.txt. */
export function savedListPath(listId: string, probe: Probe): string {
  const base = listId === 'custom' ? `custom-${slug(probe.device || probe.model || probe.host)}` : slug(listId)
  return join(cytvDir(), 'lists', `${base}.txt`)
}

/** Python's Path.resolve(): absolute with symlinks followed (macOS /var is /private/var). */
function pyResolve(p: string): string {
  try { return realpathSync.native(p) } catch { return resolve(p) }
}

function listDigest(listPath: string): string {
  return createHash('sha1').update(pyResolve(listPath)).digest('hex').slice(0, 8)
}

/** Same name as recovery.py: one record per TV and list, the list identified by its absolute path. */
export function recordPath(listPath: string, host: string): string {
  const tag = (host || 'no-host').replace(/[^A-Za-z0-9.-]/g, '_')
  return join(cytvDir(), `recovery-${tag}-${listDigest(listPath)}.json`)
}

export interface RecoveryRecord {
  version: number
  created: string
  host: string
  list: string
  home: string | null
  settings: Record<string, string>
  packages: Record<string, PackageState>
  /**
   * ro.product.device of the TV the record was taken from. Not in upstream's format (recovery.py
   * ignores it); it lets the app follow the TV to a new address and refuse another device's record.
   */
  device?: string
}

export function loadRecord(path: string): RecoveryRecord {
  let record: RecoveryRecord
  try {
    record = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`${path}: not a usable recovery record (${(e as Error).message}). It is left where it is: move it aside deliberately.`)
  }
  if (record.version !== VERSION || typeof record.packages !== 'object' || !record.packages) {
    throw new Error(`${path}: unknown recovery record format; move it aside deliberately.`)
  }
  // Records written before save() left the chooser out hold it as Home, and "android" among the
  // packages with it. Everything else in them is the TV before cleanup, so the chooser and that one
  // entry are dropped here, which reads the record the way save() writes it now. Older records can
  // also hold a Home that is no launcher, which restore would pin Home to: only that Home is
  // dropped, since the package's entry is its state before cleanup (upstream load_record).
  const rawHome: unknown = record.home
  if (typeof rawHome === 'string' && HOME_RE.test(rawHome) && isChooser(rawHome)) {
    delete record.packages[rawHome.split('/')[0]]
    record.home = null
    log(TASK, 'info', `${path}: the recorded Home is Android's chooser (${rawHome}), not a launcher; reading it as no Home, so undo resolves the stock launcher.`)
  } else if (typeof rawHome === 'string' && HOME_RE.test(rawHome) && notALauncher(rawHome)) {
    record.home = null
    log(TASK, 'info', `${path}: the recorded Home is ${rawHome}, which is not a launcher; reading it as no Home, so undo resolves the stock launcher.`)
  }
  // The record is replayed on the TV's shell: a hand-edited or damaged file stops here.
  for (const [name, state] of Object.entries(record.packages)) {
    if (!T.PACKAGE_RE.test(name)) throw new Error(`${path}: not a package name: ${name}`)
    if (!['absent', 'disabled', 'enabled'].includes(state)) throw new Error(`${path}: unknown state for ${name}: ${state}`)
  }
  if (record.home != null && !(typeof record.home === 'string' && HOME_RE.test(record.home))) {
    throw new Error(`${path}: not a Home component: ${record.home}`)
  }
  if (record.settings != null && typeof record.settings !== 'object') throw new Error(`${path}: settings is not a mapping`)
  if (record.device != null && typeof record.device !== 'string') throw new Error(`${path}: device is not a string`)
  return record
}

/**
 * The record for this TV and list. `host` is the endpoint as typed (with a port); on the network a
 * TV is its IP address, so the record is named without the port, while a record under the old name
 * with the port is still read, as upstream find_record does. When the TV got a new address, its
 * record is found by device and list and moved to the new name, so undo keeps the state from before
 * the first cleanup. A record taken from another device is refused.
 */
export function findRecord(listPath: string, host: string, device: string | undefined): { path: string; record: RecoveryRecord | null } {
  const path = recordPath(listPath, host.replace(/:\d+$/, ''))
  const names = [...new Set([path, recordPath(listPath, host)])]
  const found = names.filter((n) => existsSync(n))
  if (found.length > 1) {
    throw new Error(`This TV and list have two recovery records, under the name older versions gave it and the one it gets now:\n  ${found.join('\n  ')}\n` +
      'They may be this TV before and after cleanup, or two TVs that had this address in turn. Move the one that is not this TV\'s state from before cleanup aside deliberately, then run this again. Nothing was changed on the TV.')
  }
  if (found.length === 1) {
    if (found[0] !== path) log(TASK, 'info', `using ${found[0]}, the name an older version gave this TV's record.`)
    const record = loadRecord(found[0])
    if (record.device && device && record.device !== device) {
      throw new Error(`The restore record for ${host} was taken from another device (${record.device}); this TV reports ${device}. ` +
        `Nothing was changed. If the TV at this address really is new, move ${found[0]} aside first.`)
    }
    return { path: found[0], record }
  }
  if (device && existsSync(cytvDir())) {
    const list = pyResolve(listPath)
    for (const name of readdirSync(cytvDir())) {
      if (!/^recovery-.*\.json$/.test(name)) continue
      const old = join(cytvDir(), name)
      let record: RecoveryRecord
      try { record = loadRecord(old) } catch { continue }
      if (record.list !== list || record.device !== device) continue
      log(TASK, 'info', `this TV moved from ${record.host} to ${host}; keeping its restore record from ${record.created}`)
      writeRecord(path, { ...record, host })
      renameSync(old, old + '.moved')
      return { path, record: { ...record, host } }
    }
  }
  return { path, record: null }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]))
  }
  return value
}

/** Written next to its final name first, as recovery.py does: a crash must not leave half a record. */
export function writeRecord(path: string, record: RecoveryRecord): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  const tmp = path + '.tmp'
  // A leftover tmp from a crash is removed, and the new one is created fresh ('wx'): never written
  // through a file or link that was already there.
  rmSync(tmp, { force: true })
  writeFileSync(tmp, JSON.stringify(sortKeys(record), null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  const fd = openSync(tmp, 'r+')
  try { fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, path)
}

export function strftimeNow(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`
}

function stateOf(name: string, installed: Set<string>, disabled: Set<string>): PackageState {
  return !installed.has(name) ? 'absent' : disabled.has(name) ? 'disabled' : 'enabled'
}

/**
 * Records for this same list under another address that read like this TV before an earlier run: a
 * package this run finds disabled, which that record holds as enabled before its own cleanup
 * (upstream cleaned_by_another_record). A second TV cleaned with the same list reads the same way.
 */
function cleanedByAnotherRecord(listPath: string, writtenPath: string, disabled: Set<string>): Array<{ tag: string; other: string; names: string[] }> {
  const found: Array<{ tag: string; other: string; names: string[] }> = []
  if (!existsSync(cytvDir())) return found
  const suffix = `-${listDigest(listPath)}.json`
  for (const name of readdirSync(cytvDir()).sort()) {
    if (!name.startsWith('recovery-') || !name.endsWith(suffix)) continue
    const other = join(cytvDir(), name)
    if (other === writtenPath) continue
    let recorded: unknown
    try {
      recorded = (JSON.parse(readFileSync(other, 'utf8')) as RecoveryRecord).packages
    } catch {
      continue
    }
    if (!recorded || typeof recorded !== 'object') continue
    const names = Object.entries(recorded as Record<string, unknown>)
      .filter(([n, s]) => s === 'enabled' && disabled.has(n)).map(([n]) => n).sort()
    if (names.length) found.push({ tag: name.slice('recovery-'.length, -suffix.length), other, names })
  }
  return found
}

/** recovery.py --save: the first record wins; later runs only add names the list gained. */
export async function saveRecord(listPath: string, host: string, packages: string[], device?: string): Promise<RecoveryRecord> {
  const found = findRecord(listPath, host, device)
  const path = found.path
  if (found.record) {
    const record = found.record
    const added = packages.filter((p) => !(p in record.packages))
    // Only a name the record does not hold, or holds as absent, can change it, and only then is
    // the TV asked (upstream save/extend_record).
    const recheck = packages.some((p) => record.packages[p] === 'absent')
    log(TASK, 'info', `keeping the recovery record from ${record.created}: ${path}`)
    if (added.length || recheck) {
      const { installed, disabled } = await T.packageSets()
      for (const name of added) record.packages[name] = stateOf(name, installed, disabled)
      // A package recorded as absent that is installed and enabled now arrived after the record was
      // taken: an update or the Play Store put it there, so its state now is its state before
      // cleanup. One installed but disabled stays absent: nobody can say what switched it off.
      const arrived = packages.filter((p) => record.packages[p] === 'absent' && stateOf(p, installed, disabled) === 'enabled')
      for (const name of arrived) record.packages[name] = 'enabled'
      if (added.length || arrived.length) {
        writeRecord(path, record)
        if (added.length) log(TASK, 'info', `added ${added.length} names the list gained since then: ${added.join(', ')}`)
        if (arrived.length) log(TASK, 'info', `recorded ${arrived.length} as enabled, absent when the record was taken and installed since: ${arrived.join(', ')}`)
        log(TASK, 'info', 'every other entry keeps the state from before the first run.')
      }
    }
    return record
  }
  const { installed, disabled } = await T.packageSets()
  let home = await T.homeComponent()
  const settings: Record<string, string> = {}
  for (const key of SETTINGS) settings[key] = (await T.tv().shell(`settings get global ${key}`)).trim()
  // Android's chooser answers as "android/...ResolverActivity": no launcher owns Home then, and
  // "android" is not a name the record can hold, so it is recorded as no Home at all (restore then
  // resolves the stock launcher, as it does when nothing answered HOME).
  const chooser = home && isChooser(home) ? home : null
  if (chooser) home = null
  // The launcher that owns Home may not be in the list, but it is what undo has to put back.
  const homePkg = home ? home.split('/')[0] : null
  const targets = homePkg && !packages.includes(homePkg) ? [...packages, homePkg] : packages
  // So may an installed stock launcher: undo needs its state from before, so that it turns it back
  // on only when it was on (#1714). One the factory had disabled, or that the launcher install had
  // disabled before this list, is recorded as disabled and stays off.
  for (const name of KNOWN_STOCK_LAUNCHERS) if (installed.has(name) && !targets.includes(name)) targets.push(name)
  // A Home that is no launcher (setupwraith's recovery screen, a FallbackHome, a factory test) is
  // not recorded as Home either: restore would pin Home to it with the stock launcher enabled
  // again. Its package keeps the entry above: that state is real.
  const notLauncher = home && notALauncher(home) ? home : null
  if (notLauncher) home = null
  const record: RecoveryRecord = {
    version: VERSION,
    created: strftimeNow(),
    host,
    list: pyResolve(listPath),
    home,
    settings,
    packages: Object.fromEntries(targets.map((n) => [n, stateOf(n, installed, disabled)])),
    ...(device ? { device } : {})
  }
  writeRecord(path, record)
  const already = Object.values(record.packages).filter((s) => s === 'disabled').length
  log(TASK, 'ok', `recorded ${targets.length} packages (${already} already disabled, left alone by undo) -> ${path}`)
  if (chooser) log(TASK, 'info', `HOME before: ${chooser}, Android's chooser (Home has no default), so no Home was recorded`)
  else if (notLauncher) log(TASK, 'info', `HOME before: ${notLauncher}, which is not a launcher (a setup wizard, a settings app, a FallbackHome or a factory test), so no Home was recorded`)
  else log(TASK, 'info', `Home before: ${home ?? 'no component answered'}`)
  // A fresh record is also what a TV on a new DHCP lease looks like: the record from before its
  // cleanup is still under the old address, and nothing in it reaches undo from here (#2139).
  for (const { tag, other, names } of cleanedByAnotherRecord(listPath, path, disabled)) {
    const shown = names.slice(0, 5).join(', ') + (names.length > 5 ? ', ...' : '')
    log(TASK, 'warn', `a new restore point was written for this list, and one for the same list is under ${tag}: ${other}. ` +
      `${names.length} of the packages switched off now are recorded there as enabled before an earlier cleanup (${shown}). ` +
      'If this is that TV on a new address, restoring from here leaves those off: restore from the older point first. ' +
      'If this is a second TV cleaned with the same list, nothing is wrong: both points stay.')
  }
  return record
}

/** recovery.py --commands: the batch that puts the recorded states back. */
export function restoreCommands(listPackages: string[], record: RecoveryRecord | null, stock: string, notes: string[]): string[] {
  if (!T.PACKAGE_RE.test(stock)) throw new Error(`not a package name: ${stock}`)
  const cmds: string[] = []
  const resolveStock = `cmd package set-home-activity --user 0 $(${T.HOME_QUERY} ${stock} | tail -n 1)`
  if (!record) {
    notes.push('[STRING_PLACEHOLDER_1]')
    for (const n of listPackages) cmds.push(`pm enable ${n}`)
    cmds.push(`pm enable ${stock}`)
    cmds.push(resolveStock)
    for (const k of SETTINGS) cmds.push(`settings put global ${k} 1.0`)
    cmds.push('pm list packages -d')
    return cmds
  }
  const states = record.packages
  const reEnable = Object.keys(states).filter((n) => states[n] === 'enabled')
  for (const n of reEnable) cmds.push(`pm enable ${n}`)
  const untouched = Object.keys(states).filter((n) => states[n] !== 'enabled')
  if (untouched.length) notes.push(`Left as they were before cleanup: ${untouched.join(', ')}`)
  // The stock launcher comes back only when the record holds it as enabled, which reEnable above
  // already covers (#1714): restore enables what was on before cleanup and nothing else. One the
  // record holds as disabled was off before this list (the factory, or the launcher install before
  // the list), and one it does not hold at all cannot be said to have been on, so neither is
  // turned on here.
  const fallbackState = states[stock]
  const home = record.home
  if (home && home.split('/')[0] !== CUSTOM_LAUNCHER) cmds.push(`cmd package set-home-activity --user 0 ${home}`)
  else if (home && fallbackState !== 'enabled') {
    // This project's launcher owned Home and the stock launcher was not on: Home stays where it
    // was. Its package is in the record as enabled, so it was enabled above.
    cmds.push(`cmd package set-home-activity --user 0 ${home}`)
    notes.push(`Home goes back to ${home}, which owned it when the record was taken: ${stock} was ${fallbackState ?? 'not in the record'} then, so it stays as it is. ` +
      `To have it back, untick ${stock} in the list to switch it on, then use the Launcher step's "Give Home back" button.`)
  } else if (!home && (fallbackState === 'disabled' || fallbackState === 'absent')) {
    // No Home was recorded and the stock launcher was off or missing: there is nothing to resolve.
    notes.push(`Leaving Home alone: none was recorded, and ${stock} was ${fallbackState} when the record was taken.`)
  } else cmds.push(resolveStock)
  for (const k of SETTINGS) {
    const v = String(record.settings?.[k] ?? '').trim()
    if (v === 'null') cmds.push(`settings delete global ${k}`)
    else if (SCALE_RE.test(v)) cmds.push(`settings put global ${k} ${v}`)
    else notes.push(`Skipping ${k}: the record holds ${JSON.stringify(v) || 'nothing'}, not a number`)
  }
  const edited = listPackages.filter((n) => !(n in states))
  if (edited.length) notes.push(`Not in the record, left alone: ${edited.join(', ')}`)
  cmds.push('pm list packages -d')
  return cmds
}

// ---- plan, apply, restore -------------------------------------------------------------------------

// Features people notice when they are gone. Whatever a list says, these are the owner's call: they are
// never ticked by default (upstream's prompt asks about them before anything is disabled).
const FEATURES: Record<string, string> = {
  'com.google.android.tv.remote.service': 'the phone remote (Google TV / Android TV Remote app)',
  'com.google.android.apps.mediashell': 'casting from phones (Chromecast built-in)',
  'com.google.android.katniss': 'voice search and the remote\'s mic button',
  'com.google.android.speech.pumpkin': 'voice search and the remote\'s mic button'
}

/** Why a package is the owner's decision rather than a default, or undefined when it is plain bloat. */
export function choiceFor(e: ListEntry): string | undefined {
  if (FEATURES[e.pkg]) return `Turns off ${FEATURES[e.pkg]}.`
  if (e.section && /^(personal choice|optional)\b/i.test(e.section)) return e.section
  return undefined
}

function sourceList(listId: string): { title: string; parsed: ParsedList } {
  if (listId === 'custom') {
    const entries = [...commonality().entries()]
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .map(([pkg, c]) => ({ pkg, note: c.note, suggested: false }))
    return { title: 'Custom list', parsed: { header: ['Custom list made with CleanMyTV from packages other TVs disable.'], entries } }
  }
  const l = upstreamLists().find((u) => u.id === listId)
  if (!l) throw new Error(`no such list: ${listId}`)
  return { title: l.title, parsed: l.parsed }
}

/** Active package lines of the list this app saved earlier for this TV, if any. */
function savedActive(file: string): string[] {
  if (!existsSync(file)) return []
  try {
    return parseList(readFileSync(file, 'utf8'), file).entries.filter((e) => e.suggested).map((e) => e.pkg)
  } catch {
    return []
  }
}

export async function plan(listId: string): Promise<DebloatPlan> {
  const probe = T.getStatus().probe
  if (!probe) throw new Error('Connect to a TV first.')
  const { title, parsed } = sourceList(listId)
  const { installed, disabled } = await T.packageSets()
  const file = savedListPath(listId, probe)
  const { path: rpath, record } = findRecord(file, T.getStatus().host ?? probe.host, probe.device || undefined)
  const common = commonality()
  let entries: DebloatEntry[] = parsed.entries.map((e) => ({
    pkg: e.pkg,
    note: e.note || common.get(e.pkg)?.note || '',
    suggested: e.suggested,
    state: stateOf(e.pkg, installed, disabled),
    recorded: record?.packages[e.pkg],
    common: common.get(e.pkg)?.count ?? 0,
    choice: choiceFor(e)
  }))
  // The custom list is every package other TVs disable: only the ones on this TV are worth showing.
  if (listId === 'custom') entries = entries.filter((e) => e.state !== 'absent')
  const home = await T.homeComponent()
  return {
    listId,
    title,
    header: parsed.header,
    entries,
    record: record ? { path: rpath, created: record.created } : undefined,
    homePackage: home ? home.split('/')[0] : null
  }
}

function writeSavedList(file: string, title: string, header: string[], active: string[], known: ListEntry[]): void {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
  const notes = new Map(known.map((e) => [e.pkg, e.note]))
  const width = Math.max(40, ...known.map((e) => e.pkg.length + 2))
  const line = (pkg: string): string => {
    const note = notes.get(pkg)
    return note ? `${pkg.padEnd(width)}# ${note}` : pkg
  }
  const kept = known.map((e) => e.pkg).filter((p) => !active.includes(p))
  const out = [
    `# ${title}`,
    ...header.slice(1).map((h) => `# ${h}`.trimEnd()),
    '#',
    `# Written by CleanMyTV on ${strftimeNow()}. Undo from the app, or with upstream:`,
    `#   TV_HOST=<tv ip> tools/restore.sh ${file}`,
    '',
    ...active.map(line),
    '',
    '# Kept (not disabled):',
    ...kept.map((p) => `# ${line(p)}`)
  ]
  writeFileSync(file, out.join('\n') + '\n')
}

export async function apply(req: DebloatApplyRequest): Promise<ApplyResult> {
  const probe = T.getStatus().probe
  if (!probe) throw new Error('Connect to a TV first.')
  for (const p of [...req.disable, ...req.enable]) if (!T.PACKAGE_RE.test(p)) throw new Error(`not a package name: ${p}`)
  // Core Android packages: refused before the TV is touched, with no override (upstream #884).
  const core = corePackages(req.disable)
  if (core.length) {
    throw new Error(`Refusing the list: it switches off core Android packages, and without them the TV may not boot again:\n  ${core.join('\n  ')}\nUntick these and apply again. Nothing was changed on the TV.`)
  }
  const { title, parsed } = sourceList(req.listId)
  const host = T.getStatus().host ?? probe.host
  const warnings: string[] = []
  let pkgs = [...new Set(req.disable)]
  // Say when a safety override is on (upstream #1845).
  if (req.forceHome) log(TASK, 'info', 'note: the Home guard override is on; the current Home app will be switched off too.')
  if (req.forceSetupwraith) log(TASK, 'info', 'note: the setup-wizard override is on; setupwraith will be switched off even if it owns the Wi-Fi network.')
  if (req.forceTvInput) log(TASK, 'info', 'note: the input-driver override is on; HDMI/AV input drivers will be switched off too.')
  if (req.forceHandlers) log(TASK, 'info', 'note: the handlers override is on; the apps that open inputs and Settings will be switched off too.')

  // A Wi-Fi network saved during the first-run wizard belongs to setupwraith, and Android deletes it the
  // moment setupwraith is disabled: the TV drops off Wi-Fi, and ADB with it.
  if (pkgs.includes(SETUPWRAITH) && !req.forceSetupwraith) {
    let wifi = ''
    try { wifi = await T.sh(TASK, 'dumpsys wifi', { quiet: true }) } catch { wifi = '' }
    const owners = wifi.match(/cname=[^ ]*/g) ?? []
    if (!owners.length) {
      warnings.push(`Skipped ${SETUPWRAITH}: could not check which app owns the saved Wi-Fi networks. Try again, or force it if the TV uses Ethernet.`)
      pkgs = pkgs.filter((p) => p !== SETUPWRAITH)
    } else if (owners.some((o) => o.includes('setupwraith'))) {
      warnings.push(`Skipped ${SETUPWRAITH}: the saved Wi-Fi network belongs to it, and disabling it would delete that network and take the TV off Wi-Fi. On the TV, forget the network and join it again in Settings > Network & Internet, then apply again.`)
      pkgs = pkgs.filter((p) => p !== SETUPWRAITH)
    }
  }

  // Home guard: never leave the TV with nothing that can answer Home (upstream #239, #565, #795).
  if (!req.forceHome && pkgs.length) {
    const { pkg: homePkg, chooser } = await T.homeOwner()
    if (homePkg) {
      // The extra query is worth it only when the list holds Home's own package, which is how a
      // list that leaves the TV without a launcher looks before anything is disabled.
      if (pkgs.includes(homePkg)) {
        const claims = await T.homeClaims()
        const launchers = T.launchersIn(claims)
        const others = launchers.filter((c) => c !== homePkg && !pkgs.includes(c))
        // Another launcher is not enough while setupwraith answers HOME and stays enabled (not
        // listed, or skipped above for the Wi-Fi network): on Google TV its RecoveryActivity
        // answers ahead of an installed launcher, so with the owner switched off Home goes to it,
        // not to the launcher that is merely installed (#1573).
        const setupHome = claims.some((c) => c.startsWith(SETUPWRAITH + '/')) && !pkgs.includes(SETUPWRAITH)
        if (!others.length) {
          warnings.push(`Skipped ${homePkg}: it owns Home and nothing else that can answer Home stays enabled. Install the new launcher first (Launcher step), then apply again.`)
          pkgs = pkgs.filter((p) => p !== homePkg)
        } else if (setupHome) {
          warnings.push(`Skipped ${homePkg}: it owns Home, and ${SETUPWRAITH} stays enabled and answers Home ahead of the other launchers here, so with ${homePkg} switched off Home would go to its RecoveryActivity, the black screen the TV can crash-loop on. Install the new launcher first (Launcher step), or switch off setupwraith in the same run, then apply again.`)
          pkgs = pkgs.filter((p) => p !== homePkg)
        }
      }
    } else {
      // No single owner: Android's chooser, or neither query named one. Skipping the guard here
      // would let a list take every launcher, so fail closed: judge by the HOME claimants, and if
      // the TV cannot list those either, keep every known stock launcher.
      let launchers: string[] | null = null
      try {
        launchers = T.launchersIn(await T.homeClaims())
      } catch {
        launchers = null
      }
      if (launchers) {
        const listed = launchers.filter((l) => pkgs.includes(l))
        const others = launchers.filter((l) => !pkgs.includes(l))
        if (listed.length && !others.length) {
          for (const p of listed) {
            warnings.push(`Skipped ${p}: Home has no default, and once the list is applied no other app could answer Home. Install the new launcher first (Launcher step), then apply again.`)
            pkgs = pkgs.filter((x) => x !== p)
          }
        }
      } else {
        for (const p of KNOWN_STOCK_LAUNCHERS) {
          if (!pkgs.includes(p)) continue
          warnings.push(`Skipped ${p}: could not ask the TV which apps answer Home, and it is a stock launcher. Apply again once the TV answers.`)
          pkgs = pkgs.filter((x) => x !== p)
        }
      }
    }
    // Neither query named Home, so the guard above could only go by the apps that answer Home. Say
    // so: a silent fallback looks exactly like a check that passed (#795).
    if (pkgs.length && !homePkg) {
      const checked = 'Check that the list does not hold your launcher before applying it. The replacement launcher needs Android 8.0, so on an older set the stock launcher is the only Home there is: switched off, it leaves nothing to start.'
      warnings.push(chooser
        ? `Home has no default on this TV (the chooser shows), so the Home guard went by the apps that answer Home instead. ${checked}`
        : `Could not tell which app owns Home on this TV, so the Home guard went by the apps that answer Home instead. ${checked}`)
    }
  }

  // A package that asks for TV_INPUT_HARDWARE is usually the software layer under the HDMI, AV and
  // tuner inputs: routing, the HDCP handshake and scaling live in it (upstream #321).
  if (!req.forceTvInput && pkgs.length) {
    try {
      const { drivers, unchecked } = await T.tvInputCheck(pkgs)
      // A dump with neither block is one the guard cannot read: the package is kept off the batch
      // instead of passing silently (a black input is easy to blame on the cable).
      for (const p of unchecked) {
        warnings.push(`Skipped ${p}: the TV's answer cannot be read for the input-driver check, so it stays enabled. Once every input still works after a reboot, use the Safety overrides below to switch it off.`)
        pkgs = pkgs.filter((x) => x !== p)
      }
      for (const p of drivers) {
        warnings.push(`Skipped ${p}: it asks for android.permission.TV_INPUT_HARDWARE, so it is the software layer under the HDMI/AV/tuner inputs. With it switched off those inputs still notice the cable but stay black ("No Signal"), and only a full restore plus a cold boot brings the picture back (#321). Asking for the permission is not proof, though: check every input after a reboot before trusting it, then use the Safety overrides below to switch it off.`)
        pkgs = pkgs.filter((x) => x !== p)
      }
    } catch (e) {
      // Do not skip anything on a guess, but say the check did not run.
      warnings.push(`Could not check which listed packages drive the HDMI/AV inputs (${(e as Error).message}). Check every input after this run: a port that notices the cable and stays black means one of them was switched off, and only a full restore and a cold boot bring it back (#321).`)
    }
  }

  // The launcher switches to an HDMI input with ACTION_VIEW on a passthrough channel URI, and its
  // Settings entry opens android.settings.SETTINGS. Whichever app answers those on this TV has to
  // stay: disabled, the input tiles do nothing and Settings does not open (upstream handler guard).
  if (!req.forceHandlers && pkgs.length) {
    try {
      const { inputApps, settingsApps, inconclusive } = await T.handlerCheck()
      if (inconclusive) {
        warnings.push('Could not check which listed packages open the TV\'s inputs and Settings: the query answered with nothing at all. After this run, open an HDMI input and Settings from the launcher before you put the remote down.')
      }
      for (const p of inputApps) {
        if (!pkgs.includes(p)) continue
        warnings.push(`Skipped ${p}: the TV opens its HDMI/AV inputs and channels with it, so with it switched off the launcher's input tiles do nothing. Use the Safety overrides below to switch it off anyway.`)
        pkgs = pkgs.filter((x) => x !== p)
      }
      for (const p of settingsApps) {
        if (!pkgs.includes(p)) continue
        warnings.push(`Skipped ${p}: the TV opens Settings with it, so with it switched off Settings does not open (and with it the way back to Developer options). Use the Safety overrides below to switch it off anyway.`)
        pkgs = pkgs.filter((x) => x !== p)
      }
    } catch (e) {
      warnings.push(`Could not check which listed packages open the TV's inputs and Settings (${(e as Error).message}). After this run, open an HDMI input and Settings from the launcher before you put the remote down.`)
    }
  }

  const adbSecure = probe.adbSecure

  // The saved list holds everything this app has chosen to disable on this TV so far, minus what
  // the user switched back on; the record is written from it before the first command.
  const file = savedListPath(req.listId, probe)
  const active = [...new Set([...savedActive(file), ...req.disable])].filter((p) => !req.enable.includes(p))
  writeSavedList(file, title, parsed.header, active, parsed.entries)
  log(TASK, 'info', `list saved to ${file}`)
  // Automatic recovery point before anything changes (best-effort: the record below is the
  // net that always holds). Deferred use only: recovery.ts also imports this module.
  try {
    await autoSnapshot('debloat')
  } catch (e) {
    warnings.push(`Automatic recovery point failed (${(e as Error).message}); the recovery record below is still written.`)
  }

  const record = await saveRecord(file, host, active, probe.device || undefined)

  // The batch is one transaction: a dead connection halfway through replays the record that was
  // just written instead of leaving half a list applied. A package the TV answers oddly about is
  // still a soft warning, not a rollback: only a hard failure reverts.
  let done = 0
  let enabled = 0
  const planned = [...pkgs.map((p) => `disable ${p}`), ...req.enable.map((p) => `enable ${p}`)]
  const tx = await runTx(TASK, `Apply ${title}`, [{
    label: `switch ${pkgs.length} off, ${req.enable.length} on`,
    plan: planned.length > 10 ? [...planned.slice(0, 10), `…and ${planned.length - 10} more`] : planned,
    snapshot: async () => record,
    apply: async () => {
      for (const p of pkgs) {
        const out = await T.sh(TASK, `pm disable-user --user 0 ${p}`)
        if (/disabled/.test(out)) done++
        else warnings.push(`${p}: ${out.trim() || 'no answer'}`)
      }
      for (const p of req.enable) {
        const out = await T.sh(TASK, `pm enable ${p}`)
        if (/enabled/.test(out)) enabled++
        else warnings.push(`${p}: ${out.trim() || 'no answer'}`)
      }
    },
    verify: async () => {
      await T.sh(TASK, 'echo alive')
    },
    rollback: async (snap) => {
      const notes: string[] = []
      const cmds = restoreCommands(active, snap, await stockFallback(), notes)
      for (const n of notes) log(TASK, 'info', `rollback: ${n}`)
      await T.batch(TASK, cmds)
    }
  }])
  if (!tx.ok) throw new Error(`Apply failed partway (${tx.error}); the TV was rolled back to the recovery record${tx.rollbackError ? `, but: ${tx.rollbackError}` : ''}.`)
  if (adbSecure === '0') {
    warnings.push('This TV reports ro.adb.secure=0: network debugging accepts any device on your network without the Allow prompt. Switch debugging off when you are done (Finish step).')
  } else if (adbSecure === '') {
    // An empty value counts too: on a debug build, and on Android 4.4, adbd reads a missing
    // ro.adb.secure as 0 (upstream #1720).
    warnings.push('This TV does not set ro.adb.secure. On a debug (userdebug) build or Android 4.4 that is the same as ro.adb.secure=0: network debugging accepts any device on your network without the Allow prompt. Switch debugging off when you are done (Finish step).')
  }
  const summary = !pkgs.length && !req.enable.length
    ? 'Nothing was switched off.'
    : `Disabled ${done} of ${pkgs.length} package${pkgs.length === 1 ? '' : 's'}` + (req.enable.length ? `, switched ${enabled} back on.` : '.')
  log(TASK, 'ok', summary)
  return { ok: done === pkgs.length && enabled === req.enable.length, summary, warnings }
}

async function stockFallback(): Promise<string> {
  const { installed } = await T.packageSets()
  return KNOWN_STOCK_LAUNCHERS.find((p) => installed.has(p)) ?? 'com.google.android.tvlauncher'
}

export async function restore(listId: string): Promise<ApplyResult> {
  const probe = T.getStatus().probe
  if (!probe) throw new Error('Connect to a TV first.')
  const file = savedListPath(listId, probe)
  const { record } = findRecord(file, T.getStatus().host ?? probe.host, probe.device || undefined)
  const listPkgs = existsSync(file) ? savedActive(file) : sourceList(listId).parsed.entries.filter((e) => e.suggested).map((e) => e.pkg)
  const notes: string[] = []
  const cmds = restoreCommands(listPkgs, record, await stockFallback(), notes)
  for (const n of notes) log('restore', 'info', n)
  await T.batch('restore', cmds)
  const home = await T.homeComponent()
  const summary = record
    ? `Restored the state recorded on ${record.created}. Home is ${home ?? 'not set'}.`
    : `Enabled every package in the list. Home is ${home ?? 'not set'}.`
  log('restore', 'ok', summary)
  return { ok: true, summary, warnings: notes }
}
