import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:net'
import { configurePaths } from '../src/main/paths'
import * as T from '../src/main/tv'
import * as L from '../src/main/launcher'
import * as Th from '../src/main/theme'
import { FakeTv, newTv, startFakeAdbd } from './fake-adbd'

const home = mkdtempSync(join(tmpdir(), 'cytv-test-'))
process.env.HOME = home
// A resources folder of its own: the real lists and themes, and a stand-in APK, so this runs without
// the launcher having been built (CI builds it in a separate job).
const resources = join(home, 'resources')
mkdirSync(resources)
symlinkSync(resolve('resources/upstream'), join(resources, 'upstream'), 'junction')
writeFileSync(join(resources, 'launcher.apk'), randomBytes(200 * 1024))
writeFileSync(join(resources, 'launcher.json'), JSON.stringify({ versionName: '2.4' }))
configurePaths(resources, join(home, 'data'))

describe('launcher and theme', () => {
  let tv: FakeTv
  let server: Server
  beforeAll(async () => {
    tv = newTv()
    tv.maxData = 256 * 1024
    for (const p of ['com.google.android.apps.tv.launcherx', 'com.netflix.ninja', 'com.google.android.youtube.tv']) tv.packages.set(p, 'enabled')
    tv.home = 'com.google.android.apps.tv.launcherx/.home.HomeActivity'
    tv.homeClaims = ['com.google.android.apps.tv.launcherx/.home.HomeActivity']
    tv.leanback = ['com.netflix.ninja', 'com.google.android.youtube.tv']
    let port: number
    ;({ server, port } = await startFakeAdbd(tv))
    T.init(join(home, 'data', 'adbkey'), () => {})
    expect((await T.connect(`127.0.0.1:${port}`)).state).toBe('connected')
  })
  afterAll(() => { T.disconnect(); server.close() })

  it('installs, starts, then hands Home over and disables the stock launcher', async () => {
    const r = await L.install({ apk: 'bundled', stockLauncher: 'auto', inputKeyService: true, homeKeyService: false })
    expect(r.summary).toMatch(/Installed/)
    expect(r.ok).toBe(true)
    expect(tv.home).toBe('com.gathin.tvhome/.MainActivity')
    expect(tv.packages.get('com.google.android.apps.tv.launcherx')).toBe('disabled')
    const order = tv.commands.filter((c) => /pm install|am start -W|pm disable-user|set-home-activity/.test(c))
    expect(order.map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual(['pm install', 'am start', 'pm disable-user', 'cmd package'])
    expect(tv.commands.some((c) => c.includes('InputKeyService'))).toBe(true)
    // The old instance is stopped before the start, so the start creates a fresh one (#1101); the
    // start names HOME explicitly, and the key helper gets its TCL auto-start grant first.
    const at = (s: string): number => tv.commands.findIndex((c) => c.includes(s))
    expect(at('am force-stop com.gathin.tvhome')).toBeGreaterThan(at('pm install -r'))
    expect(at('am force-stop com.gathin.tvhome')).toBeLessThan(at('am start -W'))
    expect(tv.commands.some((c) => c.includes('am start -W -a android.intent.action.MAIN -c android.intent.category.HOME -n'))).toBe(true)
    expect(tv.commands.some((c) => c.includes('AUTO_START') && c.includes('InputKeyService'))).toBe(true)
    const st = await L.status()
    expect(st.isHome).toBe(true)
    expect(st.versionName).toBe('2.4')
  })

  it('refuses a launcher too new for the TV before pushing anything', async () => {
    writeFileSync(join(resources, 'launcher.json'), JSON.stringify({ versionName: '3.1', minSdk: 33 }))
    const before = tv.commands.length
    const r = await L.install({ apk: 'bundled', stockLauncher: 'auto', inputKeyService: false, homeKeyService: false })
    expect(r.ok).toBe(false)
    expect(r.summary).toMatch(/runs SDK 31 and the launcher needs SDK 33/)
    expect(tv.commands.slice(before)).toEqual([])
    writeFileSync(join(resources, 'launcher.json'), JSON.stringify({ versionName: '2.4' }))
  })

  it('names INSTALL_FAILED_OLDER_SDK instead of leaving a bare install failure', async () => {
    tv.installFailure = 'Failure [INSTALL_FAILED_OLDER_SDK]'
    const r = await L.install({ apk: 'bundled', stockLauncher: 'auto', inputKeyService: false, homeKeyService: false })
    expect(r.ok).toBe(false)
    expect(r.summary).toMatch(/too new for this set \(INSTALL_FAILED_OLDER_SDK\)/)
    tv.installFailure = undefined
  })

  it('gives Home back to the stock launcher', async () => {
    const r = await L.useStock()
    expect(r.ok).toBe(true)
    expect(tv.packages.get('com.google.android.apps.tv.launcherx')).toBe('enabled')
  })

  it('pushes config.json and a wallpaper, then reads them back', async () => {
    const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex')
    const r = await Th.apply({
      config: { dock_apps: ['com.google.android.youtube.tv', 'com.netflix.ninja'], columns: 5, wallpaper: true, wallpaper_dim: 30, greeting_name: '' },
      wallpaper: { kind: 'set', image: { name: 'wallpaper.jpg', base64: jpeg.toString('base64') } },
      wallpapers: { kind: 'keep' }
    })
    expect(r.ok).toBe(true)
    const back = await Th.read()
    expect(back.present).toBe(true)
    expect(back.config.dock_apps).toEqual(['com.google.android.youtube.tv', 'com.netflix.ninja'])
    expect(back.config.columns).toBe(5)
    expect(back.wallpaper).toBe(`data:image/jpeg;base64,${jpeg.toString('base64')}`)
    expect(tv.files.get('/sdcard/Android/data/com.gathin.tvhome/files/theme_revision')?.length).toBe(32)
    const apps = await Th.apps()
    expect(apps.map((a) => a.label)).toEqual(['Netflix', 'YouTube'])
  })

  it('opens the launcher when the TV will not let the shell create its folder', async () => {
    tv.appDir = 'missing'
    const before = tv.commands.length
    const r = await Th.apply({ config: { columns: 4 }, wallpaper: { kind: 'keep' }, wallpapers: { kind: 'keep' } })
    expect(r.ok).toBe(true)
    expect(tv.commands.slice(before).some((c) => c.startsWith('am start -W -n com.gathin.tvhome/.MainActivity'))).toBe(true)
  })

  it('says so plainly when the folder stays out of reach', async () => {
    tv.appDir = 'denied'
    tv.themeProvider = false
    await expect(Th.apply({ config: { columns: 4 }, wallpaper: { kind: 'keep' }, wallpapers: { kind: 'keep' } })).rejects.toThrow(/won't let the app write/)
    tv.appDir = 'ok'
    tv.themeProvider = true
  }, 15000)

  it('writes through the ThemeProvider when the shell is locked out', async () => {
    tv.appDir = 'denied'
    const r = await Th.apply({ config: { columns: 6 }, wallpaper: { kind: 'keep' }, wallpapers: { kind: 'keep' } })
    expect(r.ok).toBe(true)
    expect(tv.commands.some((c) => c.includes('content write --uri'))).toBe(true)
    tv.appDir = 'ok'
  }, 15000)

  it('refuses wallpaper names with shell syntax', async () => {
    await expect(Th.apply({ config: {}, wallpaper: { kind: 'keep' }, wallpapers: { kind: 'set', images: [{ name: 'a;reboot.jpg', base64: '' }] } })).rejects.toThrow(/unsupported/)
  })

  it('ships the upstream themes as presets', () => {
    const ids = Th.presets().map((p) => p.id)
    expect(ids).toEqual(expect.arrayContaining(['aurora', 'default', 'six-columns']))
    expect(Th.presets().find((p) => p.id === 'aurora')?.wallpaper).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('gives every preset a name and its rotation pictures', () => {
    for (const p of Th.presets()) {
      expect(p.name).toBeTruthy()
      expect(p.description).toBeTruthy()
      const dir = join(resources, 'upstream', 'themes', p.id, 'wallpapers')
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort() : []
      expect(p.wallpapers.map((w) => w.name).sort()).toEqual(files)
      for (const w of p.wallpapers) expect(w.base64.length).toBeGreaterThan(0)
    }
  })

  it('starts the component alone and grants the helper restore when asked', async () => {
    const before = tv.commands.length
    const r = await L.install({ apk: 'bundled', stockLauncher: 'none', inputKeyService: false, homeKeyService: false, restoreKeyServices: true })
    expect(r.ok).toBe(true)
    const fresh = tv.commands.slice(before)
    expect(fresh.some((c) => c === 'am start -W -n com.gathin.tvhome/.MainActivity')).toBe(true)
    expect(fresh.some((c) => c.includes('am start -W -a android.intent.action.MAIN'))).toBe(false)
    expect(fresh.some((c) => c.includes('pm grant com.gathin.tvhome android.permission.WRITE_SECURE_SETTINGS'))).toBe(true)
    expect(fresh.some((c) => c.includes('pm disable-user'))).toBe(false)
  })
})
