// One-click TV analysis and Fix: Discover -> Analyze -> Snapshot -> Fix -> Verify, behind the
// "Your TV can be improved" screen. Analyze is read-only. Fix takes an automatic recovery point,
// then reuses the typed operations (debloat apply with its guards, animation speed, theme effects)
// instead of inventing a second write path. Launcher installs stay a deliberate step: Fix points
// at them, never runs them.
import * as T from './tv'
import * as D from './debloat'
import { PKG, status as launcherStatus } from './launcher'
import { animationScale } from './system'
import { apply as applyTheme, read as readTheme } from './theme'
import { autoSnapshot } from './recovery'
import { currentDevice } from './devices'
import { log } from './log'
import type { FixReport, TvAnalysis } from '@shared/api'

const TASK = 'analyze'

/** Best-matching cleanup list for the connected TV, custom excluded. */
export function bestListId(): string {
  const probe = T.getStatus().probe
  if (!probe) throw new Error('Connect to a TV first.')
  const lists = D.lists(probe).filter((l) => l.id !== 'custom' && l.score > 0)
  if (!lists.length) throw new Error('No cleanup list matches this TV yet.')
  return lists[0].id
}

async function storage(): Promise<{ totalKb: number; availKb: number }> {
  const out = (await T.tv().shell('df /data')).replace(/\r/g, '')
  const m = /\s(\d+)\s+\d+\s+(\d+)\s+\d+%\s+\/data/.exec(out)
  if (!m) throw new Error('the TV did not answer storage info')
  return { totalKb: Number(m[1]), availKb: Number(m[2]) }
}

function level(enabledBloat: number): 'High' | 'Medium' | 'Low' {
  if (enabledBloat === 0) return 'Low'
  if (enabledBloat <= 10) return 'Medium'
  return 'High'
}

export async function analyzeTv(listId?: string): Promise<TvAnalysis> {
  const probe = T.getStatus().probe
  if (!probe) throw new Error('Connect to a TV first.')
  const id = listId ?? bestListId()
  const plan = await D.plan(id)
  const suggested = plan.entries.filter((e) => e.suggested)
  const enabledBloat = suggested.filter((e) => e.state === 'enabled').length
  const home = await T.homeComponent().catch(() => null)
  const anim = (await T.tv().shell('settings get global window_animation_scale')).trim()
  const store = await storage().catch(() => ({ totalKb: 0, availKb: 0 }))
  const low = store.totalKb > 0 && (store.availKb < 512 * 1024 || store.availKb / store.totalKb < 0.1)
  const isClean = (home ?? '').startsWith(`${PKG}/`)
  const reasons: string[] = []
  if (anim !== '0.5' && anim !== '0') reasons.push(`System animations run at ${anim || 'default'}x instead of 0.5x.`)
  if (!isClean) reasons.push(`Home opens ${home ?? 'nothing the TV names'} instead of the clean launcher.`)
  if (low) reasons.push('Storage is low.')
  const recommendations: string[] = []
  if (enabledBloat) recommendations.push(`Switch off ${enabledBloat} bloat app${enabledBloat === 1 ? '' : 's'} (Fix does it behind a recovery point).`)
  if (anim !== '0.5' && anim !== '0') recommendations.push('Set system animations to 0.5x (Fix does it).')
  if (!isClean) recommendations.push('Install the clean launcher (Launcher step, after Fix).')
  if (low) recommendations.push('Free storage: remove recordings or unused apps.')
  if (!enabledBloat && !reasons.length) recommendations.push('Nothing to fix. Take a snapshot from Recovery before experimenting.')
  return {
    takenAt: new Date().toISOString(),
    deviceId: currentDevice()?.id ?? probe.device,
    listId: id,
    listTitle: plan.title,
    adsClutter: { level: level(enabledBloat), enabledBloat, totalListed: suggested.length },
    performance: { status: reasons.length ? 'Needs optimization' : 'Good', reasons },
    privacy: { status: 'unscanned', detail: 'The privacy audit is not built yet; this card stays empty rather than guessing.' },
    storage: { ...store, low },
    launcher: { home, isClean },
    animations: anim,
    recommendations
  }
}

export async function fixTv(listId?: string): Promise<FixReport> {
  const before = await analyzeTv(listId)
  const warnings: string[] = []
  const snap = await autoSnapshot('fix')
  if (!snap) warnings.push('No automatic recovery point: this TV is not in the registry. The recovery record below still holds.')

  // 1. Debloat the matched list, with all guards, records and transaction rollback.
  const plan = await D.plan(before.listId)
  const disable = plan.entries.filter((e) => e.suggested && e.state === 'enabled').map((e) => e.pkg)
  let packagesDisabled = 0
  if (disable.length) {
    try {
      const r = await D.apply({ listId: before.listId, disable, enable: [] })
      warnings.push(...r.warnings)
      const { disabled } = await T.packageSets()
      packagesDisabled = disable.filter((p) => disabled.has(p)).length
    } catch (e) {
      // apply() already rolled back to the record; Fix stops here, honestly.
      return {
        ok: false,
        summary: `Fix stopped: ${(e as Error).message}`,
        warnings,
        snapshotId: snap?.id ?? null,
        metrics: { packagesDisabled: 0, animationsFrom: before.animations, animationsTo: before.animations, storageAvailBeforeKb: before.storage.availKb, storageAvailAfterKb: before.storage.availKb }
      }
    }
  }

  // 2. Fast/Light basics: animations at 0.5x.
  if (before.animations !== '0.5' && before.animations !== '0') {
    try {
      const r = await animationScale(0.5)
      if (!r.ok) warnings.push(`Animations: ${r.summary}`)
    } catch (e) {
      warnings.push(`Animations: ${(e as Error).message}`)
    }
  }

  // 3. Heavy launcher effects off, wallpaper and layout untouched (the owner's taste).
  try {
    const launcher = await launcherStatus().catch(() => null)
    if (launcher?.installed) {
      const current = await readTheme()
      await applyTheme({
        config: { ...current.config, reduced_motion: true, advanced_effects: false, app_glow: false, ambient_glow: false, cinematic_home: false, fade_rows: false, focus_overshoot: false },
        wallpaper: { kind: 'keep' },
        wallpapers: { kind: 'keep' }
      })
    } else {
      warnings.push('Theme effects left alone: install the clean launcher first (Launcher step).')
    }
  } catch (e) {
    warnings.push(`Theme effects: ${(e as Error).message}`)
  }

  const animationsTo = (await T.tv().shell('settings get global window_animation_scale')).trim()
  const storeAfter = await storage().catch(() => ({ totalKb: before.storage.totalKb, availKb: before.storage.availKb }))
  const parts = [`switched off ${packagesDisabled} app${packagesDisabled === 1 ? '' : 's'}`]
  if (before.animations !== animationsTo) parts.push(`animations ${before.animations || 'default'}x → ${animationsTo}x`)
  const summary = `Fixed with recovery point ${snap?.id ?? '(none)'}: ${parts.join(', ')}.`
  log(TASK, 'ok', summary)
  return {
    ok: true,
    summary,
    warnings,
    snapshotId: snap?.id ?? null,
    metrics: {
      packagesDisabled,
      animationsFrom: before.animations,
      animationsTo,
      storageAvailBeforeKb: before.storage.availKb,
      storageAvailAfterKb: storeAfter.availKb
    }
  }
}
