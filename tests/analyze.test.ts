// Analyze & Fix: one-click health dashboard, automatic recovery points, Fast/Light metrics.
import { mkdtempSync } from 'node:fs'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as T from '../src/main/tv'
import { configurePaths } from '../src/main/paths'
import * as D from '../src/main/debloat'
import * as devices from '../src/main/devices'
import * as recovery from '../src/main/recovery'
import * as analyze from '../src/main/analyze'
import { newTv, startFakeAdbd, type FakeTv } from './fake-adbd'

const home = mkdtempSync(join(tmpdir(), 'cytv-analyze-'))
process.env.HOME = home
process.env.USERPROFILE = home
configurePaths(resolve('resources'), join(home, 'data'))

describe('analyze & fix', () => {
  let tv: FakeTv
  let server: Server
  let port: number

  beforeAll(() => {
    T.init(join(home, 'data', 'adbkey'), () => {})
  })
  afterAll(() => {
    T.disconnect()
  })
  beforeEach(async () => {
    tv = newTv()
    tv.settings.set('android_id', 'aa00112233445566')
    tv.settings.set('window_animation_scale', '1')
    tv.packages.set('com.example.shell', 'enabled')
    ;({ server, port } = await startFakeAdbd(tv))
    await T.connect(`127.0.0.1:${port}`)
    await devices.registerCurrent([])
  })
  afterEach(() => {
    T.disconnect()
    server.close()
  })

  /** Two listed packages safe to disable (no core, no Home, no setup wizard). */
  async function twoBloat(listId: string): Promise<string[]> {
    const plan = await D.plan(listId)
    const homePkg = 'com.google.android.tvlauncher'
    const pkgs = plan.entries
      .filter((e) => e.suggested && D.corePackages([e.pkg]).length === 0 && e.pkg !== homePkg && e.pkg !== D.SETUPWRAITH)
      .slice(0, 2)
      .map((e) => e.pkg)
    expect(pkgs.length).toBe(2)
    for (const p of pkgs) tv.packages.set(p, 'enabled')
    return pkgs
  }

  it('grades the TV honestly', async () => {
    const first = await analyze.analyzeTv()
    await twoBloat(first.listId)
    const a = await analyze.analyzeTv(first.listId)
    expect(a.adsClutter.level).toBe('Medium')
    expect(a.adsClutter.enabledBloat).toBe(2)
    expect(a.adsClutter.totalListed).toBeGreaterThan(0)
    expect(a.performance.status).toBe('Needs optimization')
    expect(a.performance.reasons.join('\n')).toMatch(/1x instead of 0.5x/)
    expect(a.performance.reasons.join('\n')).toMatch(/instead of the clean launcher/)
    expect(a.privacy.status).toBe('unscanned')
    expect(a.storage.low).toBe(false)
    expect(a.launcher.isClean).toBe(false)
    expect(a.recommendations.length).toBeGreaterThan(0)
    tv.storageAvailKb = 100000
    const low = await analyze.analyzeTv('custom')
    expect(low.storage.low).toBe(true)
  })

  it('fixes behind one automatic recovery point, with metrics', async () => {
    const listId = (await analyze.analyzeTv()).listId
    const pkgs = await twoBloat(listId)
    const r = await analyze.fixTv(listId)
    expect(r.ok).toBe(true)
    expect(r.snapshotId).toMatch(/^20/)
    expect(r.metrics.packagesDisabled).toBe(2)
    expect(r.metrics.animationsFrom).toBe('1')
    expect(r.metrics.animationsTo).toBe('0.5')
    for (const p of pkgs) expect(tv.packages.get(p)).toBe('disabled')
    expect(tv.settings.get('window_animation_scale')).toBe('0.5')
    // The debloat inside Fix reused the same automatic point: no duplicates.
    expect(recovery.listSnapshots()).toHaveLength(1)
    // And a second Fix reuses it too.
    const r2 = await analyze.fixTv('custom')
    expect(r2.ok).toBe(true)
    expect(r2.snapshotId).toBe(r.snapshotId)
    expect(r2.metrics.packagesDisabled).toBe(0)
    expect(recovery.listSnapshots()).toHaveLength(1)
  })

  it('skips the snapshot quietly when the TV is not registered', async () => {
    devices.removeDevice('adb-aa00112233445566')
    expect(await recovery.autoSnapshot('fix')).toBeNull()
  })
})
