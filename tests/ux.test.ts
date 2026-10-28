import { describe, expect, it } from 'vitest'
import { COMMANDS, filterCommands, fuzzyScore, suggestNextStep } from '../src/renderer/src/lib/commands'
import { readPref } from '../src/renderer/src/lib/prefs'
import type { TvAnalysis } from '../src/shared/api'

describe('fuzzyScore', () => {
  it('scores an empty query as neutral', () => {
    expect(fuzzyScore('', 'Fix My TV')).toBe(0)
    expect(fuzzyScore('   ', 'Fix My TV')).toBe(0)
  })

  it('prefers prefix and word-start matches over scattered ones', () => {
    const prefix = fuzzyScore('fix', 'Fix My TV')
    const scattered = fuzzyScore('fix', 'Suffix box')
    expect(prefix).toBeGreaterThan(0)
    expect(scattered).toBeGreaterThan(0)
    expect(prefix).toBeGreaterThan(scattered)
  })

  it('matches case-insensitively and in order only', () => {
    expect(fuzzyScore('GTEX', 'Go to TV extras')).toBeGreaterThan(0)
    expect(fuzzyScore('XETG', 'Go to TV extras')).toBe(-1)
  })

  it('returns -1 when a character is missing', () => {
    expect(fuzzyScore('fixz', 'Fix My TV')).toBe(-1)
  })
})

describe('filterCommands', () => {
  it('returns everything on an empty query', () => {
    expect(filterCommands(COMMANDS, '')).toHaveLength(COMMANDS.length)
  })

  it('ranks the direct match first', () => {
    const hits = filterCommands(COMMANDS, 'fix my tv')
    expect(hits[0]?.id).toBe('fix-tv')
  })

  it('matches keywords, not just titles', () => {
    expect(filterCommands(COMMANDS, 'restart').map((c) => c.id)).toContain('reboot')
  })

  it('returns nothing for gibberish', () => {
    expect(filterCommands(COMMANDS, 'xyzzy-plugh')).toHaveLength(0)
  })
})

function analysis(over: Partial<TvAnalysis>): TvAnalysis {
  return {
    takenAt: '2026-10-28T00:00:00.000Z',
    deviceId: 'adb-test',
    listId: 'custom',
    listTitle: 'Custom',
    adsClutter: { level: 'Low', enabledBloat: 0, totalListed: 10 },
    performance: { status: 'Good', reasons: [] },
    privacy: { status: 'unscanned', detail: '' },
    storage: { totalKb: 100, availKb: 60, low: false },
    launcher: { home: 'clean', isClean: true },
    animations: '0.5',
    recommendations: [],
    ...over
  }
}

describe('suggestNextStep', () => {
  it('suggests the guided run when cluttered and stock', () => {
    const s = suggestNextStep(
      analysis({ launcher: { home: 'stock', isClean: false }, adsClutter: { level: 'High', enabledBloat: 8, totalListed: 10 } })
    )
    expect(s?.step).toBe('guided')
  })

  it('suggests the launcher when clean but stock', () => {
    const s = suggestNextStep(analysis({ launcher: { home: 'stock', isClean: false } }))
    expect(s?.step).toBe('launcher')
  })

  it('suggests clean up when cluttered but already on the clean launcher', () => {
    const s = suggestNextStep(analysis({ adsClutter: { level: 'Medium', enabledBloat: 4, totalListed: 10 } }))
    expect(s?.step).toBe('debloat')
    expect(s?.reason).toContain('4 of 10')
  })

  it('suggests extras when only performance lags', () => {
    const s = suggestNextStep(
      analysis({ performance: { status: 'Needs optimization', reasons: ['Animations at 1x'] } })
    )
    expect(s?.step).toBe('extras')
  })

  it('suggests nothing when the TV looks good', () => {
    expect(suggestNextStep(analysis({}))).toBeNull()
  })
})

describe('prefs without storage', () => {
  it('readPref falls back to null where localStorage does not exist', () => {
    expect(typeof localStorage).toBe('undefined')
    expect(readPref('theme')).toBeNull()
  })
})
