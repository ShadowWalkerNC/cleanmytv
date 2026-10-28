// The launcher's config.json overlay and wallpapers on the TV: the port of upstream tools/theme.sh,
// plus reading the current theme back so the app edits what is really there.
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './paths'
import { log } from './log'
import * as T from './tv'
import { PKG } from './launcherPkg'
import { runTx } from './tx'
import type { ApplyResult, ImageFile, LauncherConfig, ThemeApplyRequest, ThemePreset, TvApp, TvTheme } from '@shared/api'

const TASK = 'theme'
const DIR = `/sdcard/Android/data/${PKG}/files`

// Restart Home so it rereads the theme. A force-stop drops the app's accessibility services from the
// enabled list (asynchronously), so put the list back if it had ours, as theme.sh does.
const RESTART = `a=$(settings get secure enabled_accessibility_services); am force-stop ${PKG}; am start -n ${PKG}/.MainActivity >/dev/null; case "$a" in *${PKG}*) sleep 1; settings put secure enabled_accessibility_services ''; settings put secure enabled_accessibility_services "$a"; settings put secure accessibility_enabled 1 ;; esac`

// Some firmware locks the shell out of Android/data, and on Android 14 a file the shell creates
// there belongs to the shell, so the launcher gets EACCES opening it and silently ignores the
// theme. Files are staged in /data/local/tmp and written through the launcher's ThemeProvider
// first (which creates them as the launcher); cp stays as the fallback for firmware without the
// provider (upstream theme.sh).
const URI = `content://${PKG}.theme`
const TMP = '/data/local/tmp/cyt-theme'
// A file's staging path; wallpapers/a.jpg is staged as $TMP-wallpapers-a.jpg.
const stage = (name: string): string => `${TMP}-${name.replace(/\//g, '-')}`
// Android 8 and 9 have no `content write`: they print "[ERROR] Unsupported operation: write" but
// exit 0, so that message counts as a failure and cp runs.
function put(name: string): string {
  const t = stage(name)
  return `rm -f ${DIR}/${name} 2>/dev/null; { o=$(content write --uri ${URI}/${name} < ${t} 2>&1) && case "$o" in *'Unsupported operation'*) false ;; esac; } || cp ${t} ${DIR}/${name} 2>/dev/null; rm -f ${t}`
}
function del(name: string): string {
  return `rm -f ${DIR}/${name} 2>/dev/null; content delete --uri ${URI}/${name} 2>/dev/null`
}
// The collection a theme can push. A push empties it before writing the theme's own pictures, and
// a reset empties it too: the launcher's wallpaper picker lists that folder itself, so a reset
// that left the pictures behind still shows the theme it just removed.
const CLEAR_WALLPAPERS = `mkdir -p ${DIR}/wallpapers 2>/dev/null; rm -f ${DIR}/wallpapers/*.[jJ][pP][gG] ${DIR}/wallpapers/*.[jJ][pP][eE][gG] ${DIR}/wallpapers/*.[pP][nN][gG] ${DIR}/wallpapers/*.[wW][eE][bB][pP] 2>/dev/null; content delete --uri ${URI}/wallpapers 2>/dev/null`

// Since Android 11 the shell may write inside Android/data/<pkg> but some TVs (TCL, #20) refuse to
// create that folder: only the app can, the first time it asks Android for it. So check by writing
// a file, and if that fails, open the launcher once so it makes the folder, then check again.
// When the shell stays locked out, the push still goes through the ThemeProvider.
const WRITABLE = `mkdir -p ${DIR}/wallpapers 2>&1; touch ${DIR}/.cytv 2>&1 && rm -f ${DIR}/.cytv && echo writable`

async function ensureDir(): Promise<boolean> {
  let out = await T.sh(TASK, WRITABLE)
  for (let i = 0; i < 3 && !out.includes('writable'); i++) {
    if (i === 0) await T.sh(TASK, `am start -W -n ${PKG}/.MainActivity`)
    await new Promise((r) => setTimeout(r, 1500))
    out = await T.sh(TASK, WRITABLE)
  }
  return out.includes('writable')
}

function unreachable(): Error {
  return new Error(`This TV won't let the app write the launcher's settings folder (${DIR}). ` +
    'Press Home on the remote so the launcher opens, then try again. If it still fails, ' +
    'please report your TV model and Android version on GitHub.')
}

export async function read(): Promise<TvTheme> {
  const raw = await T.pullB64(`${DIR}/config.json`)
  let config: LauncherConfig = {}
  if (raw) {
    try { config = JSON.parse(raw.toString('utf8').replace(/^﻿/, '')) } catch { config = {} }
  }
  const wall = await T.pullB64(`${DIR}/wallpaper.jpg`)
  const ls = await T.tv().shell(`ls ${DIR}/wallpapers 2>/dev/null`)
  return {
    config,
    present: !!raw,
    wallpaper: wall && wall.length ? `data:image/jpeg;base64,${wall.toString('base64')}` : null,
    wallpapers: ls.split(/\s+/).filter((n) => /^[A-Za-z0-9_.-]+\.(jpe?g|png|webp)$/i.test(n))
  }
}

function checkImageName(img: ImageFile): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(img.name) || img.name.includes('..')) throw new Error(`unsupported wallpaper filename: ${img.name}`)
}

interface ThemeSnap {
  /** False when the shell is locked out: prior bytes cannot be read, so rollback is a no-op. */
  readable: boolean
  config: Buffer | null
  wallpaper: Buffer | null
  collection: Array<{ name: string; data: Buffer | null }>
}

async function snapshotTheme(shellWritable: boolean): Promise<ThemeSnap> {
  if (!shellWritable) return { readable: false, config: null, wallpaper: null, collection: [] }
  const config = await T.pullB64(`${DIR}/config.json`)
  const wallpaper = await T.pullB64(`${DIR}/wallpaper.jpg`)
  const ls = await T.tv().shell(`ls ${DIR}/wallpapers 2>/dev/null`)
  const names = ls.split(/\s+/).filter((n) => /^[A-Za-z0-9_.-]+\.(jpe?g|png|webp)$/i.test(n)).slice(0, 100)
  const collection: ThemeSnap['collection'] = []
  let bytes = 0
  for (const name of names) {
    const data = bytes < 16 * 1024 * 1024 ? await T.pullB64(`${DIR}/wallpapers/${name}`) : null
    if (data) bytes += data.length
    collection.push({ name, data })
  }
  return { readable: true, config, wallpaper, collection }
}

async function rollbackTheme(snap: ThemeSnap): Promise<void> {
  if (!snap.readable) {
    // A failed push through the provider lands nothing when it fails, so the old theme is
    // untouched; and its bytes cannot be read back to prove it. Nothing to revert.
    log(TASK, 'info', 'theme rollback: the shell is locked out, but a failed provider push lands nothing, so the old theme stands')
    return
  }
  if (snap.config) {
    await T.pushB64(TASK, snap.config, stage('config.json'))
    await T.sh(TASK, put('config.json'))
  } else {
    await T.sh(TASK, del('config.json'))
  }
  if (snap.wallpaper) {
    await T.pushB64(TASK, snap.wallpaper, stage('wallpaper.jpg'))
    await T.sh(TASK, put('wallpaper.jpg'))
  } else {
    await T.sh(TASK, del('wallpaper.jpg'))
  }
  await T.sh(TASK, CLEAR_WALLPAPERS)
  const missing: string[] = []
  for (const { name, data } of snap.collection) {
    if (data) {
      await T.pushB64(TASK, data, stage(`wallpapers/${name}`))
      await T.sh(TASK, put(`wallpapers/${name}`))
    } else missing.push(name)
  }
  if (missing.length) throw new Error(`prior rotation pictures not restored: ${missing.join(', ')}`)
}

/** Drops keys the launcher would ignore anyway, so the file on the TV stays readable. */
function clean(config: LauncherConfig): LauncherConfig {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config)) {
    if (v === undefined || v === null) continue
    if (typeof v === 'string' && v === '' && !['greeting_name', 'live_tv_package', 'vpn_app'].includes(k)) continue
    out[k] = v
  }
  return out as LauncherConfig
}

export async function apply(req: ThemeApplyRequest): Promise<ApplyResult> {
  const json = Buffer.from(JSON.stringify(clean(req.config), null, 2) + '\n')
  if (json.length > 64 * 1024) throw new Error('config.json would be over 64 KB; the launcher ignores files that large.')
  // Every collection name is checked before anything changes on the TV: a name refused halfway
  // through the push would leave the new config.json and part of the collection behind.
  if (req.wallpapers.kind === 'set') req.wallpapers.images.forEach(checkImageName)
  const shellWritable = await ensureDir()
  const tx = await runTx(TASK, 'Apply theme', [{
    label: 'push theme files',
    plan: [
      'config.json',
      req.wallpaper.kind === 'set' ? 'wallpaper.jpg' : req.wallpaper.kind === 'remove' ? 'remove wallpaper.jpg' : 'keep wallpaper.jpg',
      req.wallpapers.kind === 'set' ? `${req.wallpapers.images.length} rotation pictures` : 'keep rotation pictures'
    ],
    snapshot: () => snapshotTheme(shellWritable),
    apply: async () => {
      await T.pushB64(TASK, json, stage('config.json'))
      await T.sh(TASK, put('config.json'))
      if (req.wallpaper.kind === 'set') {
        await T.pushB64(TASK, Buffer.from(req.wallpaper.image.base64, 'base64'), stage('wallpaper.jpg'))
        await T.sh(TASK, put('wallpaper.jpg'))
      } else if (req.wallpaper.kind === 'remove') {
        await T.sh(TASK, del('wallpaper.jpg'))
      }
      if (req.wallpapers.kind === 'set') {
        await T.sh(TASK, CLEAR_WALLPAPERS)
        for (const img of req.wallpapers.images) {
          await T.pushB64(TASK, Buffer.from(img.base64, 'base64'), stage(`wallpapers/${img.name}`))
          await T.sh(TASK, put(`wallpapers/${img.name}`))
        }
      }
      // A new revision makes the launcher clear on-TV column and motion choices, even for identical bytes.
      const rev = randomUUID().replace(/-/g, '')
      await T.sh(TASK, `printf '%s' '${rev}' > ${stage('theme_revision')}; ${put('theme_revision')}`)
    },
    // The provider path swallows failures by design, so read the config back: through the
    // provider when the shell is locked out, or directly when it can read. A silent miss would
    // report "applied" while the TV kept its old look.
    verify: async () => {
      const back = shellWritable
        ? await T.pullB64(`${DIR}/config.json`)
        : Buffer.from(await T.tv().shell(`content read --uri ${URI}/config.json 2>/dev/null`), 'utf8')
      if (!back || !back.length) throw unreachable()
    },
    rollback: rollbackTheme
  }])
  if (!tx.ok) throw new Error(`Theme apply failed (${tx.error})${tx.rolledBack.length ? '; the previous theme was put back' : ''}${tx.rollbackError ? `, but: ${tx.rollbackError}` : ''}.`)
  await T.sh(TASK, `${RESTART}; echo applied`)
  log(TASK, 'ok', 'Theme applied; Home restarted.')
  return { ok: true, summary: 'Applied. The TV restarted its home screen.', warnings: [] }
}

export async function reset(): Promise<ApplyResult> {
  const shellWritable = await ensureDir()
  const tx = await runTx(TASK, 'Reset theme', [{
    label: 'remove the custom theme',
    plan: ['remove config.json, wallpaper.jpg and the rotation collection'],
    snapshot: () => snapshotTheme(shellWritable),
    apply: async () => {
      // A reset empties the collection too, and drops its captions: the launcher's wallpaper
      // picker lists that folder itself, so leftovers would still show the theme just removed.
      await T.sh(TASK, `mkdir -p ${DIR} 2>/dev/null; ${del('config.json')}; ${del('wallpaper.jpg')}; ${del('wallpapers/captions.txt')}; ${CLEAR_WALLPAPERS}; printf '%s' '${randomUUID().replace(/-/g, '')}' > ${stage('theme_revision')}; ${put('theme_revision')}`)
    },
    verify: async () => {
      const back = shellWritable
        ? await T.pullB64(`${DIR}/config.json`)
        : Buffer.from(await T.tv().shell(`content read --uri ${URI}/config.json 2>/dev/null`), 'utf8')
      if (back && back.length) throw new Error('the old config.json is still there')
    },
    rollback: rollbackTheme
  }])
  if (!tx.ok) throw new Error(`Theme reset failed (${tx.error})${tx.rolledBack.length ? '; the previous theme was put back' : ''}${tx.rollbackError ? `, but: ${tx.rollbackError}` : ''}.`)
  await T.sh(TASK, `${RESTART}; echo reset`)
  return { ok: true, summary: 'Back to the built-in look.', warnings: [] }
}

const PRESET_TEXT: Record<string, [string, string]> = {
  default: ['Default', 'The built-in look: black, four columns, no wallpaper.'],
  aurora: ['Aurora', 'A dark aurora wallpaper, teal and violet on navy.'],
  dussehra: ['Dussehra', 'Festive skin: marigold toran, diya for Wi-Fi, bell for Inputs, petal shower.'],
  glass: ['Glass', 'Frosted-glass dock, horizon glow and cinematic shelf over a dark wallpaper.'],
  'nature-calm': ['Nature calm', 'Twelve calm photos in rotation with captions, six columns, translucent dock.'],
  retro: ['Retro', 'Time-of-day moods on quiet black: morning, evening and night wallpapers.'],
  ruska: ['Ruska', 'Finnish autumn minimal: dark wallpaper, soft app glow, no clutter.'],
  scenes: ['Scenes', 'Fourteen world photos in hourly rotation.'],
  'six-columns': ['Six columns', 'Six smaller tiles per row and one grid row under the dock.'],
  sweden: ['Sweden', 'Swedish light in rotation with captions, six columns, translucent dock.']
}

export function presets(): ThemePreset[] {
  if (!existsSync(paths.themes)) return []
  return readdirSync(paths.themes).sort().flatMap((id) => {
    const cfg = join(paths.themes, id, 'config.json')
    if (!existsSync(cfg)) return []
    const wall = join(paths.themes, id, 'wallpaper.jpg')
    const [name, description] = PRESET_TEXT[id] ?? [id, '']
    const wallpapers: ImageFile[] = []
    const collection = join(paths.themes, id, 'wallpapers')
    if (existsSync(collection)) {
      for (const f of readdirSync(collection).sort()) {
        if (!/\.(jpe?g|png|webp)$/i.test(f)) continue
        wallpapers.push({ name: f, base64: readFileSync(join(collection, f)).toString('base64') })
      }
    }
    return [{
      id,
      name,
      description,
      config: JSON.parse(readFileSync(cfg, 'utf8')),
      wallpaper: existsSync(wall) ? `data:image/jpeg;base64,${readFileSync(wall).toString('base64')}` : null,
      wallpapers
    }]
  })
}

// Names for apps people put on a TV; anything else gets a name made from its package.
const KNOWN: Record<string, string> = {
  'com.netflix.ninja': 'Netflix',
  'com.google.android.youtube.tv': 'YouTube',
  'com.google.android.youtube.tvkids': 'YouTube Kids',
  'com.google.android.youtube.tvmusic': 'YouTube Music',
  'com.amazon.amazonvideo.livingroom': 'Prime Video',
  'com.disney.disneyplus': 'Disney+',
  'in.startv.hotstar': 'JioHotstar',
  'com.spotify.tv.android': 'Spotify',
  'com.plexapp.android': 'Plex',
  'org.jellyfin.androidtv': 'Jellyfin',
  'org.xbmc.kodi': 'Kodi',
  'com.apple.atve.androidtv.appletv': 'Apple TV',
  'com.wbd.stream': 'Max',
  'com.hbo.hbonow': 'HBO Max',
  'com.hulu.livingroomplus': 'Hulu',
  'tv.twitch.android.app': 'Twitch',
  'com.google.android.videos': 'Google TV',
  'com.google.android.apps.youtube.unplugged': 'YouTube TV',
  'com.android.vending': 'Play Store',
  'com.android.tv.settings': 'Settings',
  'com.google.android.tvlauncher': 'Stock launcher',
  'com.google.android.apps.tv.launcherx': 'Google TV home',
  'com.mediatek.wwtv.tvcenter': 'Live TV',
  'com.sony.dtv.tvlin': 'Live TV',
  'com.stremio.one': 'Stremio',
  'com.peacocktv.peacockandroid': 'Peacock',
  'com.cbs.ott': 'Paramount+',
  'com.crunchyroll.crunchyroid': 'Crunchyroll',
  'com.bbc.iplayer.tv': 'BBC iPlayer',
  'air.ITVMobilePlayer': 'ITVX',
  'com.zee5.androidtv': 'ZEE5',
  'com.jio.media.stb.ondemand': 'JioCinema',
  'com.sonyliv': 'Sony LIV',
  'com.fancode.tv': 'FanCode',
  'com.globo.globotv': 'Globoplay',
  'com.vrt.vrtmax.androidtv': 'VRT MAX',
  'tv.pluto.android': 'Pluto TV',
  'com.tubitv': 'Tubi',
  'com.android.chrome': 'Chrome',
  'com.amazon.music.tv': 'Amazon Music',
  'com.apple.android.music': 'Apple Music',
  'com.google.android.apps.mediashell': 'Chromecast',
  'com.teamsmart.videomanager.tv': 'SmartTube',
  'com.liskovsoft.smarttubetv.beta': 'SmartTube',
  'com.cetusplay.remoteservice': 'CetusPlay',
  'com.vanced.android.youtube': 'YouTube Vanced',
  'com.mxtech.videoplayer.ad': 'MX Player',
  'org.videolan.vlc': 'VLC'
}

export function labelFor(pkg: string): string {
  if (KNOWN[pkg]) return KNOWN[pkg]
  const parts = pkg.split('.').filter((p) => !['com', 'org', 'net', 'tv', 'android', 'app', 'apps', 'androidtv', 'atv', 'in', 'co', 'www', 'livingroom', 'ott', 'mobile'].includes(p.toLowerCase()))
  const word = parts[parts.length > 1 ? 1 : 0] ?? pkg.split('.').pop() ?? pkg
  return word.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase())
}

function packagesIn(out: string): Set<string> {
  const s = new Set<string>()
  for (const line of out.split('\n')) {
    const m = /^\s*([A-Za-z0-9_.]+)\/\S+/.exec(line)
    if (m) s.add(m[1])
  }
  return s
}

/** Apps the launcher can show as tiles: TV (leanback) apps, then ordinary launcher apps. */
export async function apps(): Promise<TvApp[]> {
  const tvOut = await T.tv().shell('cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER')
  const phoneOut = await T.tv().shell('cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER')
  const tvPkgs = packagesIn(tvOut)
  const phonePkgs = packagesIn(phoneOut)
  const skip = new Set([PKG, 'com.android.tv.settings', 'com.android.settings'])
  const all: TvApp[] = []
  for (const pkg of tvPkgs) if (!skip.has(pkg)) all.push({ pkg, label: labelFor(pkg), tv: true })
  for (const pkg of phonePkgs) if (!skip.has(pkg) && !tvPkgs.has(pkg)) all.push({ pkg, label: labelFor(pkg), tv: false })
  return all.sort((a, b) => Number(b.tv) - Number(a.tv) || a.label.localeCompare(b.label))
}

export async function screenshot(): Promise<string> {
  const f = '/data/local/tmp/cytv-shot.png'
  await T.tv().shell(`screencap -p ${f}`, 30000)
  const png = await T.pullB64(f)
  await T.tv().shell(`rm -f ${f}`)
  if (!png || png.length < 100) throw new Error('The TV returned an empty screenshot. Live TV, HDMI and some streaming apps block capture: press Home and try again.')
  return `data:image/png;base64,${png.toString('base64')}`
}
