import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, publicDecrypt, constants, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { androidPublicKey, loadKeys, sign } from '../src/main/adb/keys'
import { configurePaths } from '../src/main/paths'
import * as T from '../src/main/tv'
import * as D from '../src/main/debloat'
import { decodeAndroidKey, FakeTv, newTv, startFakeAdbd } from './fake-adbd'
import type { Server } from 'node:net'

const home = mkdtempSync(join(tmpdir(), 'cytv-test-'))
process.env.HOME = home
process.env.USERPROFILE = home
configurePaths(resolve('resources'), join(home, 'data'))
const UPSTREAM = process.env.UPSTREAM_DIR

describe('adb keys', () => {
  it('encodes the public key the way adbd reads it', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
    const pub = androidPublicKey(privateKey)
    const { key, n0inv, raw, words } = decodeAndroidKey(pub)
    expect(words).toBe(64)
    // n0inv * n[0] == -1 mod 2^32
    const n0 = BigInt(raw.readUInt32LE(8))
    expect((BigInt(n0inv) * n0) % (1n << 32n)).toBe((1n << 32n) - 1n)
    const token = randomBytes(20)
    const sig = sign({ path: '', priv: privateKey, pub }, token)
    const digest = Buffer.from('3021300906052b0e03021a05000414', 'hex')
    expect(publicDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, sig).equals(Buffer.concat([digest, token]))).toBe(true)
  })
})

describe('talking to a TV', () => {
  let tv: FakeTv
  let server: Server
  let port: number
  let prompts = 0

  beforeAll(async () => {
    tv = newTv()
    ;({ server, port } = await startFakeAdbd(tv))
    T.init(join(home, 'data', 'adbkey'), (s) => { if (s.state === 'waiting-auth') prompts++ })
  })
  afterAll(() => { T.disconnect(); server.close() })

  it('asks the TV once, then reconnects with the trusted key', async () => {
    const s = await T.connect(`127.0.0.1:${port}`)
    expect(s.state).toBe('connected')
    expect(s.probe?.model).toBe('BRAVIA 4K VH2')
    expect(prompts).toBe(1)
    T.disconnect()
    const again = await T.connect(`127.0.0.1:${port}`)
    expect(again.state).toBe('connected')
    expect(prompts).toBe(1)
    expect(T.host()).toBe('127.0.0.1')
  })

  it('uploads in chunks that fit a 4 KB TV and reads files back', async () => {
    const data = randomBytes(50_000)
    await T.pushB64('test', data, '/data/local/tmp/x.bin')
    expect(tv.files.get('/data/local/tmp/x.bin')?.equals(data)).toBe(true)
    const back = await T.pullB64('/data/local/tmp/x.bin')
    expect(back?.equals(data)).toBe(true)
    expect(await T.pullB64('/data/local/tmp/missing')).toBeNull()
  })

  it('refuses shell syntax in names', () => {
    expect(() => T.q('/sdcard/a;reboot')).toThrow()
  })

  it('debloats with the home and setupwraith guards, then restores the recorded state', async () => {
    for (const p of ['com.google.android.tvlauncher', 'com.sony.dtv.promos', 'com.sony.dtv.analytics', D.SETUPWRAITH, 'com.android.tv.settings']) tv.packages.set(p, 'enabled')
    tv.packages.set('com.sony.dtv.alreadyoff', 'disabled')
    tv.homeClaims = ['com.google.android.tvlauncher/.MainActivity', `${D.SETUPWRAITH}/.RecoveryActivity`, 'com.android.tv.settings/.Home']
    tv.wifiOwners = `cname=${D.SETUPWRAITH}`
    tv.settings.set('window_animation_scale', '0.5')

    const r = await D.apply({ listId: 'custom', disable: ['com.google.android.tvlauncher', 'com.sony.dtv.promos', 'com.sony.dtv.analytics', D.SETUPWRAITH, 'com.sony.dtv.alreadyoff'], enable: [] })
    expect(r.warnings.join('\n')).toMatch(/Skipped com.google.android.tvlauncher: it owns Home/)
    expect(r.warnings.join('\n')).toMatch(/Skipped com.google.android.tungsten.setupwraith: the saved Wi-Fi network belongs to it/)
    expect(tv.packages.get('com.google.android.tvlauncher')).toBe('enabled')
    expect(tv.packages.get(D.SETUPWRAITH)).toBe('enabled')
    expect(tv.packages.get('com.sony.dtv.promos')).toBe('disabled')

    const list = D.savedListPath('custom', T.getStatus().probe!)
    const record = D.loadRecord(D.recordPath(list, '127.0.0.1'))
    expect(record.packages['com.sony.dtv.promos']).toBe('enabled')
    expect(record.packages['com.sony.dtv.alreadyoff']).toBe('disabled')
    expect(record.home).toBe('com.google.android.tvlauncher/.MainActivity')
    expect(record.settings.window_animation_scale).toBe('0.5')

    const res = await D.restore('custom')
    expect(res.ok).toBe(true)
    expect(tv.packages.get('com.sony.dtv.promos')).toBe('enabled')
    expect(tv.packages.get('com.sony.dtv.alreadyoff')).toBe('disabled')   // it was off before cleanup
    expect(tv.commands).toContain('settings put global window_animation_scale 0.5')
  })

  it('writes the record upstream recovery.py reads, and builds the same restore batch', async () => {
    if (!UPSTREAM) return
    const list = D.savedListPath('custom', T.getStatus().probe!)
    const notes: string[] = []
    const ours = D.restoreCommands(D.parseList(readFileSync(list, 'utf8')).entries.filter((e) => e.suggested).map((e) => e.pkg),
      D.loadRecord(D.recordPath(list, '127.0.0.1')), 'com.google.android.tvlauncher', notes)
    const theirs = execFileSync('python3', ['-I', join(UPSTREAM, 'tools', 'recovery.py'), '--commands', list, 'com.google.android.tvlauncher'],
      { env: { ...process.env, HOME: home, TV_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'ignore'] }).toString().replace(/\r/g, '').trim().split('\n')
    expect(ours).toEqual(theirs)
  })
})

describe('core packages', () => {
  it('names what no list may disable, and allows the tested exceptions', () => {
    expect(D.corePackages([
      'android', 'com.android.systemui', 'com.android.shell', 'com.android.phone',
      'com.android.settings', 'com.android.tv.settings',
      'com.android.permissioncontroller', 'com.google.android.permissioncontroller',
      'com.android.packageinstaller', 'com.android.ext.services', 'com.google.android.ext.shared',
      'android.ext.services', 'android.ext.shared', 'com.android.modulemetadata',
      'com.google.android.overlay.modules.foo', 'com.android.providers.media',
      'com.cltv.mal', 'com.mediatek.tis', 'com.mediatek.tv.service', 'com.mediatek.tv.agent'
    ])).toHaveLength(20)
    expect(D.corePackages([
      'com.android.providers.calendar', 'com.android.providers.contacts',
      'com.android.providers.userdictionary', 'com.android.providers.blockednumber',
      'com.vendor.ads', 'com.google.android.tvlauncher'
    ])).toEqual([])
  })
})

describe('v3 safety guards', () => {
  let tv: FakeTv
  let server: Server
  let port: number
  let listIds: string[]

  beforeAll(() => {
    listIds = D.lists(undefined).filter((l) => l.id !== 'custom').map((l) => l.id)
  })
  beforeEach(async () => {
    tv = newTv()
    ;({ server, port } = await startFakeAdbd(tv))
    await T.connect(`127.0.0.1:${port}`)
  })
  afterEach(() => { T.disconnect(); server.close() })
  // One list per test, so every apply writes a fresh record.
  const listId = (i: number): string => listIds[i % listIds.length]

  it('refuses a list naming core packages before touching the TV', async () => {
    tv.packages.set('com.android.systemui', 'enabled')
    const before = tv.commands.length
    await expect(D.apply({ listId: listId(0), disable: ['com.android.systemui'], enable: [] })).rejects.toThrow(/core Android packages/)
    expect(tv.commands.slice(before)).toEqual([])
  })

  it('keeps the stock launcher while setupwraith answers Home', async () => {
    for (const p of ['com.google.android.apps.tv.launcherx', 'com.gathin.tvhome', D.SETUPWRAITH]) tv.packages.set(p, 'enabled')
    tv.home = 'com.google.android.apps.tv.launcherx/.HomeActivity'
    tv.homeClaims = ['com.google.android.apps.tv.launcherx/.HomeActivity', `${D.SETUPWRAITH}/.RecoveryActivity`, 'com.gathin.tvhome/.MainActivity']
    const r = await D.apply({ listId: listId(1), disable: ['com.google.android.apps.tv.launcherx'], enable: [] })
    expect(r.warnings.join('\n')).toMatch(/stays enabled and answers Home/)
    expect(tv.packages.get('com.google.android.apps.tv.launcherx')).toBe('enabled')
    const forced = await D.apply({ listId: listId(1), disable: ['com.google.android.apps.tv.launcherx'], enable: [], forceHome: true })
    expect(forced.warnings.join('\n')).not.toMatch(/stays enabled and answers Home/)
    expect(tv.packages.get('com.google.android.apps.tv.launcherx')).toBe('disabled')
  })

  it('skips TV input drivers and unreadable dumps unless forced', async () => {
    for (const p of ['com.mediatek.tvinput', 'com.vendor.mystery', 'com.vendor.ads']) tv.packages.set(p, 'enabled')
    tv.tvInputDrivers.add('com.mediatek.tvinput')
    tv.tvInputUnchecked.add('com.vendor.mystery')
    const r = await D.apply({ listId: listId(2), disable: ['com.mediatek.tvinput', 'com.vendor.mystery', 'com.vendor.ads'], enable: [] })
    expect(r.warnings.join('\n')).toMatch(/TV_INPUT_HARDWARE/)
    expect(r.warnings.join('\n')).toMatch(/cannot be read for the input-driver check/)
    expect(tv.packages.get('com.mediatek.tvinput')).toBe('enabled')
    expect(tv.packages.get('com.vendor.mystery')).toBe('enabled')
    expect(tv.packages.get('com.vendor.ads')).toBe('disabled')
    const forced = await D.apply({ listId: listId(2), disable: ['com.mediatek.tvinput', 'com.vendor.mystery'], enable: [], forceTvInput: true })
    expect(forced.ok).toBe(true)
    expect(tv.packages.get('com.mediatek.tvinput')).toBe('disabled')
    expect(tv.packages.get('com.vendor.mystery')).toBe('disabled')
  })

  it('skips the apps that open inputs and Settings unless forced', async () => {
    for (const p of ['com.vendor.livetv', 'com.vendor.settingsapp', 'com.vendor.ads']) tv.packages.set(p, 'enabled')
    tv.inputHandlers = ['com.vendor.livetv/.Main']
    tv.settingsHandlers = ['com.vendor.settingsapp/.Settings']
    const r = await D.apply({ listId: listId(3), disable: ['com.vendor.livetv', 'com.vendor.settingsapp', 'com.vendor.ads'], enable: [] })
    expect(r.warnings.join('\n')).toMatch(/opens its HDMI\/AV inputs/)
    expect(r.warnings.join('\n')).toMatch(/opens Settings with it/)
    expect(tv.packages.get('com.vendor.livetv')).toBe('enabled')
    expect(tv.packages.get('com.vendor.settingsapp')).toBe('enabled')
    expect(tv.packages.get('com.vendor.ads')).toBe('disabled')
    await D.apply({ listId: listId(3), disable: ['com.vendor.livetv', 'com.vendor.settingsapp'], enable: [], forceHandlers: true })
    expect(tv.packages.get('com.vendor.livetv')).toBe('disabled')
    expect(tv.packages.get('com.vendor.settingsapp')).toBe('disabled')
  })

  it('fails closed when Home has no owner', async () => {
    tv.packages.set('com.google.android.tvlauncher', 'enabled')
    tv.home = ''
    tv.homeClaims = ['com.google.android.tvlauncher/.MainActivity']
    const r = await D.apply({ listId: listId(4), disable: ['com.google.android.tvlauncher'], enable: [] })
    expect(r.warnings.join('\n')).toMatch(/no other app could answer Home/)
    expect(tv.packages.get('com.google.android.tvlauncher')).toBe('enabled')
  })

  it('does not count a FallbackHome or a factory test as another Home', async () => {
    for (const p of ['com.google.android.tvlauncher', 'com.tcl.keycustomfunctionservice', 'com.duokan.factorytest']) tv.packages.set(p, 'enabled')
    tv.home = 'com.google.android.tvlauncher/.MainActivity'
    tv.homeClaims = ['com.google.android.tvlauncher/.MainActivity', 'com.tcl.keycustomfunctionservice/.FallbackHome', 'com.duokan.factorytest/.FactoryLauncher']
    const r = await D.apply({ listId: listId(5), disable: ['com.google.android.tvlauncher'], enable: [] })
    expect(r.warnings.join('\n')).toMatch(/owns Home and nothing else/)
    expect(tv.packages.get('com.google.android.tvlauncher')).toBe('enabled')
  })

  it('records installed stock launchers and restores only what was on', async () => {
    for (const p of ['com.google.android.tvlauncher', 'com.vendor.ads']) tv.packages.set(p, 'enabled')
    await D.apply({ listId: listId(6), disable: ['com.vendor.ads'], enable: [] })
    const file = D.savedListPath(listId(6), T.getStatus().probe!)
    const record = D.loadRecord(D.recordPath(file, '127.0.0.1'))
    expect(record.packages['com.google.android.tvlauncher']).toBe('enabled')
    const notes: string[] = []
    const cmds = D.restoreCommands(['com.vendor.ads'],
      { ...record, home: 'com.gathin.tvhome/.MainActivity', packages: { ...record.packages, 'com.google.android.tvlauncher': 'disabled', 'com.gathin.tvhome': 'enabled' } },
      'com.google.android.tvlauncher', notes)
    expect(cmds).not.toContain('pm enable com.google.android.tvlauncher')
    expect(cmds).toContain('cmd package set-home-activity --user 0 com.gathin.tvhome/.MainActivity')
    expect(notes.join('\n')).toMatch(/stays as it is/)
  })

  it('reads old records holding the chooser or a non-launcher Home', () => {
    const f = join(home, 'old-record.json')
    writeFileSync(f, JSON.stringify({ version: 1, created: 'x', host: 'h', list: 'l', home: 'android/com.android.internal.app.ResolverActivity', settings: {}, packages: { android: 'enabled', 'com.vendor.ads': 'enabled' } }))
    const chooser = D.loadRecord(f)
    expect(chooser.home).toBeNull()
    expect(chooser.packages).not.toHaveProperty('android')
    writeFileSync(f, JSON.stringify({ version: 1, created: 'x', host: 'h', list: 'l', home: `${D.SETUPWRAITH}/.RecoveryActivity`, settings: {}, packages: { [D.SETUPWRAITH]: 'enabled' } }))
    const wiz = D.loadRecord(f)
    expect(wiz.home).toBeNull()
    expect(wiz.packages[D.SETUPWRAITH]).toBe('enabled')
  })

  it('refuses to choose between two records for one TV and list', () => {
    const f = join(home, 'two-lists.txt')
    writeFileSync(f, 'com.vendor.ads\n')
    const rec = { version: 1, created: 'x', host: 'h', list: f, home: null, settings: {}, packages: {} }
    const a = D.recordPath(f, '127.0.0.1')
    const b = D.recordPath(f, '127.0.0.1:5555')
    expect(a).not.toBe(b)
    D.writeRecord(a, rec)
    D.writeRecord(b, rec)
    expect(() => D.findRecord(f, '127.0.0.1:5555', undefined)).toThrow(/two recovery records/)
    rmSync(a)
    rmSync(b)
  })

  it('warns when ro.adb.secure is empty', async () => {
    tv.packages.set('com.vendor.ads', 'enabled')
    tv.adbSecure = ''
    T.disconnect()
    expect((await T.connect(`127.0.0.1:${port}`)).state).toBe('connected')
    const r = await D.apply({ listId: listId(7), disable: ['com.vendor.ads'], enable: [] })
    expect(r.warnings.join('\n')).toMatch(/does not set ro\.adb\.secure/)
  })

  it('reads package state for user 0, falling back on old firmware', async () => {
    tv.packages.set('com.vendor.ads', 'enabled')
    await T.packageSets()
    expect(tv.commands).toContain('pm list packages --user 0')
    tv.commands.length = 0
    tv.pmUser0 = false
    await T.packageSets()
    expect(tv.commands).toContain('pm list packages')
  })
})

describe('upstream lists', () => {
  it('parses every bundled list', () => {
    const all = D.lists(undefined)
    expect(all.length).toBeGreaterThan(100)
  })

  it('finds the right list for a TV', () => {
    const all = D.lists({ host: '', model: 'BRAVIA 4K VH2', device: 'BRAVIA_VH2', product: 'BRAVIA_VH2_EU', manufacturer: 'Sony', release: '12', sdk: 31, build: '', adbSecure: '1' })
    expect(all[1].id).toMatch(/sony-bravia-4k-vh2|sony/)
    expect(all[1].score).toBeGreaterThan(0)
  })

  it('offers a family-inferred list for unlisted models of a known brand', () => {
    // No list names this model, device or product, so only the brand family answers.
    const all = D.lists({ host: '', model: 'Qzzz Q9', device: 'qzzz9', product: 'qzzz9', manufacturer: 'Xiaomi', release: '9', sdk: 28, build: '', adbSecure: '1' })
    const inferred = all.find((l) => l.title.startsWith('Inferred for your Xiaomi'))
    expect(inferred).toBeDefined()
    expect(inferred!.id).toBe('xiaomi-mitv-mssp3')
  })

  it('does not infer a family when a list already matches exactly', () => {
    const all = D.lists({ host: '', model: 'MiTV-MSSP3', device: 'mssp3', product: 'mssp3', manufacturer: 'Xiaomi', release: '9', sdk: 28, build: '', adbSecure: '1' })
    expect(all.find((l) => l.title.startsWith('Inferred for your'))).toBeUndefined()
    expect(all.find((l) => l.id === 'xiaomi-mitv-mssp3')!.score).toBeGreaterThanOrEqual(5)
  })

  it('reads notes and commented-out packages', () => {
    const p = D.parseList('﻿# Header line\r\n# second\r\ncom.a.b   # ads\r\n# com.c.d   # keep this\r\n# Stock launcher: com.e.f\r\n')
    expect(p.header).toEqual(['Header line', 'second'])
    expect(p.entries).toEqual([{ pkg: 'com.a.b', note: 'ads', suggested: true, section: 'second' }, { pkg: 'com.c.d', note: 'keep this', suggested: false, section: 'second' }])
    expect(() => D.parseList('com.a.b; reboot\n')).toThrow(/not a package name/)
  })

  it("leaves the owner's choices unticked: personal-choice sections and the phone remote, casting and voice", () => {
    const text = readFileSync(resolve('resources/upstream/examples/xiaomi-mi-box-s/debloat.txt'), 'utf8')
    const entries = D.parseList(text).entries
    const by = (pkg: string) => entries.find((e) => e.pkg === pkg)!
    // Plain bloat stays a default.
    expect(D.choiceFor(by('com.mitv.tvhome.atv'))).toBeUndefined()
    // The section the Mi Box user lost the phone remote to.
    for (const pkg of ['com.google.android.tv.remote.service', 'com.google.android.apps.mediashell', 'com.mitv.milinkservice', 'com.google.android.katniss']) {
      expect(D.choiceFor(by(pkg)), pkg).toBeTruthy()
    }
    expect(D.choiceFor(by('com.mitv.milinkservice'))).toMatch(/^Personal choice: casting/)
    expect(D.choiceFor(by('com.google.android.tv.remote.service'))).toMatch(/phone remote/)
    // Known features are protected even where a list does not label them.
    expect(D.choiceFor({ pkg: 'com.google.android.tv.remote.service', note: '', suggested: true })).toMatch(/phone remote/)
    expect(D.choiceFor({ pkg: 'com.vendor.ads', note: '', suggested: true, section: 'Optional: uncomment what you do not use' })).toMatch(/^Optional/)
  })

  it('names records the way recovery.py does', () => {
    if (!UPSTREAM) return
    const f = join(home, 'list.txt')
    writeFileSync(f, 'com.a.b\n')
    const py = execFileSync('python3', ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(join(UPSTREAM, 'tools'))}); import recovery; print(recovery.record_path(${JSON.stringify(f)}, '192.168.1.50'))`],
      { env: { ...process.env, HOME: home } }).toString().trim()
    expect(D.recordPath(f, '192.168.1.50')).toBe(py)
  })
})

it('creates the app key once and derives its public half', () => {
  const keys = loadKeys(join(home, 'data', 'adbkey'))
  expect(keys).toHaveLength(1)
  expect(existsSync(join(home, 'data', 'adbkey.pub'))).toBe(true)
  expect(readFileSync(join(home, 'data', 'adbkey.pub'), 'utf8').trim()).toBe(keys[0].pub)
  expect(createHash('md5').update('x').digest('hex')).toHaveLength(32)
})
