// VIZIO provider against a stubbed TV: no LAN in tests.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { configurePaths } from '../src/main/paths'
import { _setVizioSender, currentInput, key, loadVizio, pairFinish, pairStart, power, setInput } from '../src/main/vizio'

const home = mkdtempSync(join(tmpdir(), 'cytv-vizio-'))
configurePaths(join(home, 'resources'), join(home, 'data'))

const calls: Array<{ method: string; path: string; body?: unknown; auth?: string }> = []
let pinOk = true
let powerValue: unknown = 1

beforeEach(() => {
  calls.length = 0
  pinOk = true
  powerValue = 1
  _setVizioSender(async (host, method, path, body, auth) => {
    calls.push({ method, path, body, auth })
    if (path === '/pairing/start') return { STATUS: { RESULT: 'SUCCESS' }, ITEM: { CHALLENGE_TYPE: 1, PAIRING_REQ_TOKEN: 4242 } }
    if (path === '/pairing/pair') return pinOk ? { ITEM: { AUTH_TOKEN: 'secret' } } : { ITEM: {} }
    if (path === '/state/device/power_mode') return { ITEMS: [{ CNAME: 'power_mode', VALUE: powerValue }] }
    if (path === '/key_command/') return { STATUS: { RESULT: 'SUCCESS' } }
    if (path.endsWith('/devices/current_input')) {
      if (method === 'GET') return { ITEMS: [{ VALUE: 'HDMI-1', HASHVAL: 99 }] }
      return { STATUS: { RESULT: 'SUCCESS' } }
    }
    throw new Error('unexpected ' + method + ' ' + path)
  })
})

describe('vizio pairing', () => {
  it('starts pairing and keeps the challenge token', async () => {
    await expect(pairStart('tv')).resolves.toEqual({ host: 'tv', token: 4242 })
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/pairing/start' })
  })

  it('finishes pairing and persists host + auth', async () => {
    const r = await pairFinish('tv', 4242, '1234')
    expect(r.ok).toBe(true)
    expect(loadVizio()).toEqual({ host: 'tv', auth: 'secret' })
  })

  it('rejects a bad PIN without saving', async () => {
    pinOk = false
    const r = await pairFinish('tv', 4242, '0000')
    expect(r.ok).toBe(false)
  })

  it('validates the PIN shape first', async () => {
    await expect(pairFinish('tv', 4242, 'abc')).resolves.toMatchObject({ ok: false })
    expect(calls).toHaveLength(0)
  })
})

describe('vizio commands', () => {
  beforeEach(async () => {
    await pairFinish('tv', 4242, '1234')
    calls.length = 0
  })

  it('reads numeric power state', async () => {
    await expect(power()).resolves.toEqual({ power: 'On' })
    powerValue = 0
    await expect(power()).resolves.toEqual({ power: 'Off' })
  })

  it('sends keys as KEYPRESS triples', async () => {
    await key('mute')
    expect(calls[0]?.body).toEqual({ KEYLIST: [{ CODESET: 5, CODE: 4, ACTION: 'KEYPRESS' }] })
  })

  it('rejects unknown keys', async () => {
    // @ts-expect-error probing the guard
    await expect(key('eject')).resolves.toMatchObject({ ok: false })
  })

  it('reads the current input', async () => {
    await expect(currentInput()).resolves.toEqual({ input: 'HDMI-1' })
  })

  it('sets input with the hash from a fresh GET', async () => {
    await setInput('HDMI-2')
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT'])
    expect(calls[1]?.body).toEqual({ REQUEST: 'MODIFY', VALUE: 'HDMI-2', HASHVAL: 99 })
  })
})
