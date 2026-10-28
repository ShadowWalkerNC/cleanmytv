// HDMI-CEC link probe: parsing plus the fake-TV round trip.
import { mkdtempSync } from 'node:fs'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as T from '../src/main/tv'
import { configurePaths } from '../src/main/paths'
import * as caps from '../src/main/capabilities'
import { cecState, parseCecState } from '../src/main/cec'
import { newTv, startFakeAdbd, type FakeTv } from './fake-adbd'

const home = mkdtempSync(join(tmpdir(), 'cytv-cec-'))
process.env.HOME = home
process.env.USERPROFILE = home
configurePaths(join(home, 'resources'), join(home, 'data'))

describe('cec parsing', () => {
  const ON = '  mHwCecAvailable: true\n  mIsCecAvailable: true\n  hdmi_cec_enabled (int): 1\n'

  it('reads link-up from the dumpsys markers', () => {
    expect(parseCecState(ON, '1')).toEqual({ available: true, enabled: true, detail: 'CEC link up.' })
  })

  it('reports switched-off when the service answers but the flag is 0', () => {
    const off = '  mIsCecAvailable: true\n  hdmi_cec_enabled (int): 0\n'
    const s = parseCecState(off, '0')
    expect(s.available).toBe(true)
    expect(s.enabled).toBe(false)
    expect(s.detail).toMatch(/switched off/)
  })

  it('trusts the settings flag when dumpsys is silent', () => {
    expect(parseCecState('', '1').enabled).toBe(true)
  })

  it('reports no service on garbage', () => {
    const s = parseCecState("Can't find service: hdmi_control\n", 'null')
    expect(s.available).toBe(false)
    expect(s.enabled).toBe(false)
  })
})

describe('cec probe', () => {
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
    tv.settings.set('hdmi_control_enabled', '1')
    ;({ server, port } = await startFakeAdbd(tv))
    await T.connect(`127.0.0.1:${port}`)
  })
  afterEach(() => {
    T.disconnect()
    server.close()
  })

  it('exposes the CEC state over the probe', async () => {
    expect(await cecState()).toEqual({ available: true, enabled: true, detail: 'CEC link up.' })
  })

  it('adds a display.cec capability that follows the link', async () => {
    const get = (id: string): Promise<boolean> =>
      caps.probeCapabilities().then((all) => all.find((c) => c.id === id)?.supported ?? false)
    expect(await get('display.cec')).toBe(true)
    tv.cecDumpsys = ''
    tv.settings.delete('hdmi_control_enabled')
    const off = await caps.probeCapabilities().then((all) => all.find((c) => c.id === 'display.cec'))
    expect(off?.supported).toBe(false)
    expect(off?.detail).toMatch(/No CEC service/)
  })
})
