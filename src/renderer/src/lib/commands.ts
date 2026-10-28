// The command palette's catalogue: every screen plus the actions worth running without
// opening one. Local and deterministic — fuzzy text match, capability gating, confirm
// before anything destructive. No network, no model.
import type { TvAnalysis } from '@shared/api'
import { STEPS, type StepId } from './steps'

export interface CommandOutcome {
  ok: boolean
  summary: string
}

export type CommandRun = { kind: 'go'; step: StepId } | { kind: 'fn'; label: string; fn: () => Promise<CommandOutcome> }

export interface Command {
  id: string
  title: string
  hint: string
  keywords: string
  /** Greyed out with an explanation when no TV is connected. */
  needsTv: boolean
  /** Capability id (see capabilities.ts): greyed out when the TV lacks it. */
  capability?: string
  danger?: boolean
  confirmTitle?: string
  confirmLabel?: string
  run: CommandRun
}

// Navigation is never blocked: with no TV the app shows its own "connect first"
// screen, which is the helpful path forward.
const NAV: Command[] = STEPS.map((s) => ({
  id: `go-${s.id}`,
  title: `Go to ${s.label}`,
  hint: s.sub,
  keywords: `${s.label} ${s.id} screen open`,
  needsTv: false,
  run: { kind: 'go', step: s.id }
}))

const ACTIONS: Command[] = [
  {
    id: 'fix-tv',
    title: 'Fix My TV now',
    hint: 'Snapshot, cleanup, fast settings',
    keywords: 'fix repair optimize automatic cleanup',
    needsTv: true,
    run: {
      kind: 'fn',
      label: 'Fixing your TV',
      fn: async () => {
        const r = await window.cytv.fixTv()
        return { ok: r.ok, summary: r.summary }
      }
    }
  },
  {
    id: 'snapshot',
    title: 'Take a recovery snapshot',
    hint: 'Restore point for this TV',
    keywords: 'snapshot backup save restore point',
    needsTv: true,
    run: {
      kind: 'fn',
      label: 'Taking a snapshot',
      fn: async () => {
        const s = await window.cytv.createSnapshot(`Palette ${new Date().toLocaleString()}`)
        return { ok: true, summary: `Snapshot taken (${s.id}).` }
      }
    }
  },
  {
    id: 'anim-fast',
    title: 'Set animations to 0.5x',
    hint: 'Snappier without tearing',
    keywords: 'animation speed fast performance',
    needsTv: true,
    capability: 'system.animations',
    run: {
      kind: 'fn',
      label: 'Setting animation speed',
      fn: async () => {
        const r = await window.cytv.setAnimationScale(0.5)
        return { ok: r.ok, summary: r.summary }
      }
    }
  },
  {
    id: 'anim-stock',
    title: 'Reset animations to 1x',
    hint: 'Back to stock speed',
    keywords: 'animation speed stock default reset',
    needsTv: true,
    capability: 'system.animations',
    run: {
      kind: 'fn',
      label: 'Setting animation speed',
      fn: async () => {
        const r = await window.cytv.setAnimationScale(1)
        return { ok: r.ok, summary: r.summary }
      }
    }
  },
  {
    id: 'reboot',
    title: 'Restart the TV',
    hint: 'The connection drops while it restarts',
    keywords: 'reboot restart power cycle',
    needsTv: true,
    capability: 'power.reboot',
    danger: true,
    confirmTitle: 'Restart the TV?',
    confirmLabel: 'Restart',
    run: {
      kind: 'fn',
      label: 'Restarting the TV',
      fn: async () => {
        await window.cytv.reboot()
        return { ok: true, summary: 'The TV is restarting. Connect again from Setup once it is back.' }
      }
    }
  }
]

export const COMMANDS: Command[] = [...NAV, ...ACTIONS]

/** Subsequence score: -1 when the query is not found in order; higher is a better match. */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase().trim()
  if (!q) return 0
  const t = target.toLowerCase()
  let score = 0
  let ti = 0
  let run = 0
  for (const ch of q) {
    const at = t.indexOf(ch, ti)
    if (at < 0) return -1
    if (at === ti) {
      run += 1
      score += 2 + run
    } else {
      run = 0
      score += 1
    }
    if (at === 0 || t[at - 1] === ' ') score += 2
    ti = at + 1
  }
  return score
}

export function filterCommands(cmds: Command[], query: string): Command[] {
  if (!query.trim()) return cmds
  return cmds
    .map((c) => ({ c, s: fuzzyScore(query, `${c.title} ${c.hint} ${c.keywords}`) }))
    .filter((e) => e.s >= 0)
    .sort((a, b) => b.s - a.s)
    .map((e) => e.c)
}

export interface Suggestion {
  step: StepId
  title: string
  reason: string
}

/** One deterministic next step from a TV analysis, or null when nothing stands out. */
export function suggestNextStep(a: TvAnalysis): Suggestion | null {
  if (!a.launcher.isClean && a.adsClutter.enabledBloat > 0) {
    return { step: 'guided', title: 'Run Clean & launch', reason: 'Cleanup plus the clean launcher in one pass.' }
  }
  if (!a.launcher.isClean) {
    return { step: 'launcher', title: 'Install the clean launcher', reason: 'This TV still boots to the stock Home.' }
  }
  if (a.adsClutter.enabledBloat > 0) {
    return {
      step: 'debloat',
      title: 'Switch off the listed apps',
      reason: `${a.adsClutter.enabledBloat} of ${a.adsClutter.totalListed} listed apps still on.`
    }
  }
  if (a.performance.status !== 'Good') {
    return {
      step: 'extras',
      title: 'Speed up animations',
      reason: a.performance.reasons[0] ?? 'The TV reports slow animation settings.'
    }
  }
  return null
}
