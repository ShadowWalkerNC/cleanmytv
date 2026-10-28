// The guided "Clean & launch" run (#9): one button that walks the happy path —
// pick the best-matching list, disable its suggested packages, install the
// bundled launcher, and land on Customise — while keeping every step
// inspectable and skippable. It composes the same IPC calls the individual
// screens use; no new main-process behaviour.
import { useEffect, useRef, useState } from 'react'
import type { ApplyResult, DebloatPlan } from '@shared/api'
import type { ScreenProps } from '../App'
import { Busy, StatusChip, StepProgress, errorText, type StepState } from '../components/ui'

type Phase =
  | { t: 'plan' }                       // picking the list, building the plan
  | { t: 'ready'; plan: DebloatPlan; disable: string[] }  // showing what will happen
  | { t: 'run'; step: string }          // executing
  | { t: 'done'; result: ApplyResult; customised: boolean }
  | { t: 'failed'; message: string }

export default function Guided({ go, markDone }: ScreenProps): React.ReactElement {
  const [phase, setPhase] = useState<Phase>({ t: 'plan' })
  const [progress, setProgress] = useState<StepState[] | null>(null)
  const alive = useRef(true)
  const cancelled = useRef(false)
  useEffect(() => () => { alive.current = false }, [])

  function mark(label: string, state: StepState['state'], detail?: string): void {
    setProgress((prev) => prev?.map((s) => (s.label === label ? { ...s, state, detail: detail ?? s.detail } : s)) ?? null)
  }

  useEffect(() => { if (phase.t === 'plan') void prepare() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function prepare(): Promise<void> {
    try {
      const lists = await window.cytv.lists()
      const best = lists.reduce((a, b) => (b.score > a.score ? b : a))
      if (best.score <= 0) {
        setPhase({ t: 'failed', message: 'No list matches this TV closely. Use Clean up to pick one by hand — the guided run needs a matching list to be safe.' })
        return
      }
      const plan = await window.cytv.plan(best.id)
      const suggested = plan.entries.filter((e) => e.suggested).map((e) => e.pkg)
      if (suggested.length === 0) {
        setPhase({ t: 'failed', message: 'The matching list has no suggested packages. Use Clean up to choose by hand.' })
        return
      }
      setPhase({ t: 'ready', plan, disable: suggested })
    } catch (e) {
      setPhase({ t: 'failed', message: errorText(e) })
    }
  }

  async function run(skipDebloat: boolean): Promise<void> {
    const p = phase
    if (p.t !== 'ready') return
    cancelled.current = false
    const cleanLabel = `Clean up (${p.disable.length} packages)`
    const launcherLabel = 'Install the launcher'
    setProgress([
      { label: cleanLabel, state: skipDebloat ? 'skipped' : 'todo', detail: skipDebloat ? 'Skipped by you' : undefined },
      { label: launcherLabel, state: 'todo' }
    ])
    setPhase({ t: 'run', step: 'Preparing' })
    const notes: string[] = []
    try {
      if (!skipDebloat) {
        mark(cleanLabel, 'active')
        setPhase({ t: 'run', step: `Disabling ${p.disable.length} packages from "${p.plan.title}"` })
        const r = await window.cytv.applyDebloat({
          listId: p.plan.listId,
          disable: p.disable,
          enable: [],
          forceHome: true,
          forceSetupwraith: true
        })
        if (!r.ok) throw new Error(r.summary)
        notes.push(`Cleaned up: ${p.disable.length} packages off (${r.warnings.length} warnings)`)
        mark(cleanLabel, 'done')
        if (alive.current) markDone('debloat')
        if (cancelled.current) {
          mark(launcherLabel, 'skipped', 'Stopped before this step')
          setPhase({ t: 'failed', message: `Stopped by you. ${notes.join(' · ')} — the launcher step did not run.` })
          return
        }
      } else {
        notes.push('Clean up skipped')
      }

      const before = await window.cytv.launcherStatus()
      if (!before.isHome) {
        mark(launcherLabel, 'active')
        setPhase({ t: 'run', step: 'Installing the launcher' })
        const r = await window.cytv.install({
          apk: 'bundled',
          stockLauncher: before.stockLauncher ?? 'auto',
          inputKeyService: true,
          homeKeyService: true,
          replaceIncompatible: false
        })
        if (!r.ok) throw new Error(r.summary)
        notes.push('Launcher installed and set as Home')
        mark(launcherLabel, 'done')
        if (alive.current) markDone('launcher')
      } else {
        notes.push('Launcher already Home — left as it was')
        mark(launcherLabel, 'skipped', 'Already Home')
      }

      setPhase({ t: 'done', result: { ok: true, summary: notes.join(' · '), warnings: [] }, customised: true })
    } catch (e) {
      notes.push('Stopped: ' + errorText(e))
      setPhase({ t: 'failed', message: notes.join(' · ') })
    }
  }

  return (
    <>
      <h1>Clean &amp; launch</h1>
      <p className="muted">
        The one-button path: the best-matching list for your TV, its suggested packages off, the clean
        launcher installed and set as Home — then you land on Customise. Nothing is uninstalled and
        every step stays open in the sidebar if you want to go slower.
      </p>

      {phase.t === 'plan' && <Busy text="Reading your TV and picking the matching list" />}

      {phase.t === 'ready' && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <h2 style={{ margin: 0 }}>Ready to run</h2>
            <p style={{ margin: '8px 0' }}>
              List: <b>{phase.plan.title}</b> — the closest match for your TV.
            </p>
            <p style={{ margin: '8px 0' }}>
              Will disable <b>{phase.disable.length} packages</b> (the list's suggested set — the same
              defaults Clean up pre-ticks), then install the bundled launcher and hand Home to it.
            </p>
            <p className="muted small" style={{ margin: 0 }}>
              Restore puts every package back exactly as it is now; the launcher can go back to stock
              from the Launcher step at any time.
            </p>
          </div>
          <div className="row">
            <button className="btn primary" onClick={() => void run(false)}>Clean &amp; launch</button>
            <button className="btn" onClick={() => void run(true)}>Launcher only (skip clean up)</button>
            <button className="btn ghost" onClick={() => go('debloat')}>Let me pick by hand instead</button>
          </div>
        </div>
      )}

      {phase.t === 'run' && (
        <div className="stack" style={{ gap: 16 }}>
          {progress && <StepProgress steps={progress} />}
          <Busy text={phase.step} />
          <div className="row">
            <button className="btn ghost" onClick={() => { cancelled.current = true }}>
              Stop after this step
            </button>
          </div>
        </div>
      )}

      {phase.t === 'done' && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <StatusChip status="ok" text="Done" />
            <p style={{ margin: '8px 0 0' }}>{phase.result.summary}</p>
          </div>
          {progress && <StepProgress steps={progress} />}
          <div className="row">
            <button className="btn primary" onClick={() => go('customise')}>Customise my home screen</button>
            <button className="btn ghost" onClick={() => go('finish')}>Finish (close the debug port)</button>
          </div>
        </div>
      )}

      {phase.t === 'failed' && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="notice error">{phase.message}</div>
          <div className="row">
            <button className="btn" onClick={() => { setPhase({ t: 'plan' }); void prepare() }}>Try again</button>
            <button className="btn ghost" onClick={() => go('debloat')}>Use the step-by-step screens</button>
          </div>
        </div>
      )}
    </>
  )
}
