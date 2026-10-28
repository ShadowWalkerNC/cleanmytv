import { describe, expect, it } from 'vitest'
import { nameHits } from '../src/main/scan'
import type { ManagedDevice } from '../src/shared/api'

function device(over: Partial<ManagedDevice>): ManagedDevice {
  return {
    id: 'adb-test',
    provider: 'adb',
    identity: { manufacturer: 'onn', model: '4K Streaming Box' },
    capabilities: [],
    state: 'known',
    lastSeen: '2026-10-28T00:00:00.000Z',
    ...over
  }
}

describe('nameHits', () => {
  it('labels a hit from the registry by last-seen address', () => {
    const out = nameHits([{ host: '192.168.40.228' }], [device({ lastAddress: '192.168.40.228:5555' })])
    expect(out).toEqual([{ host: '192.168.40.228', name: 'onn 4K Streaming Box' }])
  })

  it('leaves unknown addresses bare', () => {
    const out = nameHits([{ host: '192.168.40.99' }], [device({ lastAddress: '192.168.40.228:5555' })])
    expect(out).toEqual([{ host: '192.168.40.99' }])
  })

  it('does not repeat the maker when the model starts with it', () => {
    const out = nameHits(
      [{ host: '192.168.40.228' }],
      [device({ identity: { manufacturer: 'onn', model: 'onn. 4K Streaming Box' }, lastAddress: '192.168.40.228:5555' })]
    )
    expect(out[0]?.name).toBe('onn. 4K Streaming Box')
  })

  it('falls back to the device id without identity', () => {
    const out = nameHits([{ host: '192.168.40.228' }], [device({ identity: {}, lastAddress: '192.168.40.228' })])
    expect(out[0]?.name).toBe('adb-test')
  })
})
