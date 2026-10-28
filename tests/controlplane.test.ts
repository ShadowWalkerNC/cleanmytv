// Control plane: registry identity, capability probing, transactions, recovery snapshots.
import { mkdtempSync } from 'node:fs'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as T from '../src/main/tv'
import { configurePaths } from '../src/main/paths'
import * as devices from '../src/main/devices'
import * as caps from '../src/main/capabilities'
import { runTx } from '../src/main/tx'
import * as recovery from '../src/main/recovery'
import * as system from '../src/main/system'
import { newTv, startFakeAdbd, type FakeTv } from './fake-adbd'

const home = mkdtempSync(join(tmpdir(), 'cytv-plane-'))
process.env.HOME = home
process.env.USERPROFILE = home
configurePaths(join(home, 'resources'), join(home, 'data'))

describe('control plane', () => {
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
    tv.settings.set('android_id', '0011223344556677')
    ;({ server, port } = await startFakeAdbd(tv))
    await T.connect(`127.0.0.1:${port}`)
  })
  afterEach(() => {
    T.disconnect()
    server.close()
  })

  it('identifies the TV by itself, not its address', async () => {
    const first = await devices.registerCurrent([])
    expect(first.id).toBe('adb-0011223344556677')
    expect(first.id).not.toContain('127.0.0.1')
    expect(first.lastAddress).toMatch(/^127\.0\.0\.1:/)
    // Same TV on a new address (new DHCP lease): same id, no duplicate.
    T.disconnect()
    server.close()
    tv = newTv()
    tv.settings.set('android_id', '0011223344556677')
    ;({ server, port } = await startFakeAdbd(tv))
    await T.connect(`127.0.0.1:${port}`)
    const second = await devices.registerCurrent([])
    expect(second.id).toBe(first.id)
    expect(devices.listDevices().filter((d) => d.id === first.id)).toHaveLength(1)
    expect(devices.currentDevice()?.id).toBe(first.id)
  })

  it('falls back to the device slug when android_id is unreadable', async () => {
    tv.settings.delete('android_id')
    const d = await devices.registerCurrent([])
    expect(d.id).toBe('adb-bravia-vh2')
    expect(d.identity.androidId).toBeUndefined()
  })

  it('probes capabilities instead of assuming by brand', async () => {
    const all = await caps.probeCapabilities()
    const get = (id: string): boolean => all.find((c) => c.id === id)?.supported ?? false
    expect(get('shell')).toBe(true)
    expect(get('apps.list')).toBe(true)
    expect(get('apps.install')).toBe(true)
    expect(get('system.privateDns')).toBe(true)
    expect(get('launcher.setHome')).toBe(true)
    // The fake TV is API 31: per-app language needs 33.
    const locale = all.find((c) => c.id === 'system.locale')!
    expect(locale.supported).toBe(false)
    expect(locale.detail).toMatch(/API 33/)
    // A TV without `cmd` loses what needs it, and says so.
    tv.toolsMissing.add('cmd')
    const reduced = await caps.probeCapabilities()
    expect(reduced.find((c) => c.id === 'apps.launch')?.supported).toBe(false)
    expect(reduced.find((c) => c.id === 'launcher.setHome')?.detail).toMatch(/Android 7/)
  })

  it('reports capabilities without addresses or keys', async () => {
    tv.toolsMissing.add('su')
    await devices.registerCurrent([])
    const report = await caps.capabilityReport()
    expect(report.deviceId).toBe('adb-0011223344556677')
    expect(report.device.sdk).toBe(31)
    expect(report.os['ro.build.version.sdk']).toBe('31')
    expect(report.os['shell.su']).toBe('absent')
    expect(JSON.stringify(report)).not.toContain('127.0.0.1')
  })

  it('rolls back finished operations in reverse order', async () => {
    const events: string[] = []
    const op = (name: string, fail?: 'apply' | 'verify' | 'rollback') => ({
      label: name,
      plan: [`do ${name}`],
      snapshot: async () => {
        events.push(`snap-${name}`)
        return name
      },
      apply: async () => {
        events.push(`apply-${name}`)
        if (fail === 'apply') throw new Error(`${name} blew up`)
      },
      verify: async () => {
        events.push(`verify-${name}`)
        if (fail === 'verify') throw new Error(`${name} diverged`)
      },
      rollback: async () => {
        events.push(`rollback-${name}`)
        if (fail === 'rollback') throw new Error(`${name} stuck`)
      }
    })
    const r = await runTx('test', 'demo', [op('a'), op('b', 'verify'), op('c')])
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/b diverged/)
    expect(r.rolledBack).toEqual(['a'])
    expect(events).toEqual(['snap-a', 'apply-a', 'verify-a', 'snap-b', 'apply-b', 'verify-b', 'rollback-a'])
    const r2 = await runTx('test', 'demo2', [op('x'), op('y', 'apply')])
    expect(r2.ok).toBe(false)
    expect(r2.rolledBack).toEqual(['x'])
    // A failing rollback is reported, and the rest still run.
    const r3 = await runTx('test', 'demo3', [op('p', 'rollback'), op('q'), op('r', 'apply')])
    expect(r3.ok).toBe(false)
    expect(r3.rolledBack).toEqual(['q'])
    expect(r3.rollbackError).toMatch(/p stuck/)
  })

  it('writes settings transactionally', async () => {
    tv.settings.set('window_animation_scale', '1')
    const r = await system.animationScale(0.5)
    expect(r.ok).toBe(true)
    expect(tv.settings.get('window_animation_scale')).toBe('0.5')
    const d = await system.privateDns('dns.adguard-dns.com')
    expect(d.ok).toBe(true)
    expect(tv.settings.get('private_dns_mode')).toBe('hostname')
    const c = await system.clockScreensaver(true)
    expect(c.ok).toBe(true)
    expect(tv.settings.get('screensaver_components')).toContain('com.gathin.tvhome/.ClockDream')
    await expect(system.launcherLocale('de')).rejects.toThrow(/Android 13/)
  })

  it('snapshots, diffs and restores the TV state', async () => {
    for (const p of ['com.vendor.keep', 'com.vendor.flip']) tv.packages.set(p, 'enabled')
    for (const k of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) tv.settings.set(k, '1')
    await devices.registerCurrent([])
    const before = await recovery.createSnapshot('before')
    expect(before.packages).toBe(2)
    await T.sh('test', 'pm disable-user --user 0 com.vendor.flip')
    await system.animationScale(0.5)
    const after = await recovery.createSnapshot('after')
    const diff = recovery.diffSnapshots(before.id, after.id)
    expect(diff.packagesChanged).toEqual([{ pkg: 'com.vendor.flip', from: 'enabled', to: 'disabled' }])
    expect(diff.settingsChanged.map((s) => s.key)).toContain('global window_animation_scale')
    const r = await recovery.restoreSnapshot(before.id)
    expect(r.ok).toBe(true)
    expect(tv.packages.get('com.vendor.flip')).toBe('enabled')
    expect(tv.settings.get('window_animation_scale')).toBe('1')
    recovery.deleteSnapshot(before.id)
    recovery.deleteSnapshot(after.id)
    expect(recovery.listSnapshots()).toHaveLength(0)
  })

  it('refuses to restore a snapshot onto another TV', async () => {
    tv.packages.set('com.vendor.keep', 'enabled')
    await devices.registerCurrent([])
    const s = await recovery.createSnapshot('mine')
    devices.removeDevice(s.deviceId)
    await expect(recovery.restoreSnapshot(s.id)).rejects.toThrow(/only onto their own TV/)
    recovery.deleteSnapshot(s.id)
  })
})
