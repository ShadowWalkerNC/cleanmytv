import { Suspense, lazy, useEffect, useState, type ReactNode } from 'react'
import type { ConnStatus } from '@shared/api'
import { LogDrawer } from './components/LogDrawer'
import { CommandPalette } from './components/CommandPalette'
import { Busy, NotConnected } from './components/ui'
// One chunk per screen: the heavy Customise tab (drag-and-drop) loads only when opened.
const Guided = lazy(() => import('./screens/Guided'))
const Setup = lazy(() => import('./screens/Setup').then((m) => ({ default: m.Setup })))
const Devices = lazy(() => import('./screens/Devices').then((m) => ({ default: m.Devices })))
const Analyze = lazy(() => import('./screens/Analyze').then((m) => ({ default: m.Analyze })))
const Debloat = lazy(() => import('./screens/Debloat').then((m) => ({ default: m.Debloat })))
const Launcher = lazy(() => import('./screens/Launcher').then((m) => ({ default: m.Launcher })))
const Customise = lazy(() => import('./screens/Customise').then((m) => ({ default: m.Customise })))
const Extras = lazy(() => import('./screens/Extras').then((m) => ({ default: m.Extras })))
const Recovery = lazy(() => import('./screens/Recovery').then((m) => ({ default: m.Recovery })))
const Finish = lazy(() => import('./screens/Finish').then((m) => ({ default: m.Finish })))
import { version } from '../../../package.json'
import { useSidebarPref, useThemePref, type ThemeMode } from './lib/prefs'

const REPO_URL = 'https://github.com/wingedpanther/cleanmytv'

import { STEPS, type StepId } from './lib/steps'

export interface ScreenProps {
  status: ConnStatus
  go: (step: StepId) => void
  markDone: (step: StepId) => void
}

export default function App(): ReactNode {
  const [step, setStep] = useState<StepId>(() => {
    const h = location.hash.slice(1)
    // The dashboard is the default experience ("Your TV can be improved").
    return STEPS.some((s) => s.id === h) ? (h as StepId) : 'analyze'
  })
  const [status, setStatus] = useState<ConnStatus>({ state: 'idle' })
  const [done, setDone] = useState<Set<StepId>>(new Set())
  const [sidebar, setSidebar] = useSidebarPref()
  const rail = sidebar === 'rail'
  const [theme, setTheme] = useThemePref()

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('light', theme === 'light')
    root.classList.toggle('dark', theme === 'dark')
  }, [theme])

  useEffect(() => {
    // Remember the screen across restarts; the initial state reads this back.
    location.hash = step
  }, [step])

  const [palette, setPalette] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    // Coming back later to change the wallpaper or the order: reconnect to the last TV by itself.
    window.cytv.status().then((s) => {
      setStatus(s)
      if (s.state !== 'idle') return
      window.cytv.reconnect().then(async (r) => {
        if (r?.state !== 'connected') return
        // A TV that already runs the clean launcher is here to be customised: open that step.
        const ls = await window.cytv.launcherStatus()
        if (ls.isHome) {
          setDone((prev) => new Set(prev).add('launcher'))
          setStep((cur) => (cur === 'setup' ? 'customise' : cur))
        }
      }).catch(() => null)
    })
    return window.cytv.onStatus(setStatus)
  }, [])

  const connected = status.state === 'connected'
  const markDone = (s: StepId): void => setDone((prev) => new Set(prev).add(s))
  const props: ScreenProps = { status, go: setStep, markDone }
  const current = STEPS.find((s) => s.id === step)!

  let screen: ReactNode
  if (current.needsTv && !connected) screen = <NotConnected onGo={() => setStep('setup')} />
  else if (step === 'guided') screen = <Guided {...props} />
  else if (step === 'setup') screen = <Setup {...props} />
  else if (step === 'devices') screen = <Devices {...props} />
  else if (step === 'analyze') screen = <Analyze {...props} />
  else if (step === 'debloat') screen = <Debloat {...props} />
  else if (step === 'launcher') screen = <Launcher {...props} />
  else if (step === 'customise') screen = <Customise {...props} />
  else if (step === 'extras') screen = <Extras {...props} />
  else if (step === 'recovery') screen = <Recovery {...props} />
  else screen = <Finish {...props} />

  return (
    <div className={`app${rail ? ' rail' : ''}`}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand">
            <div className="brand-mark" aria-hidden />
            <span className="brand-name">CleanMyTV</span>
          </div>
          <button
            className="icon-btn rail-toggle"
            onClick={() => setSidebar(rail ? 'expanded' : 'rail')}
            aria-label={rail ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!rail}
            title={rail ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {rail ? '»' : '«'}
          </button>
        </div>
        <ConnPill status={status} />
        <nav>
          <ol className="steps">
            {STEPS.map((s, i) => {
              const isDone = s.id === 'setup' ? connected : s.id === 'guided' ? done.has('debloat') && done.has('launcher') : done.has(s.id)
              return (
                <li key={s.id}>
                  <button
                    className={`step${s.id === step ? ' active' : ''}${isDone ? ' done' : ''}`}
                    onClick={() => setStep(s.id)}
                    aria-current={s.id === step ? 'step' : undefined}
                    aria-label={s.label}
                    title={`${s.label} — ${s.sub}`}
                  >
                    <span className="step-num">{isDone ? '✓' : i + 1}</span>
                    <span className="step-label">
                      {s.label}
                      <span className="step-sub">{s.sub}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </nav>
        <div className="sidebar-foot">
          Nothing is uninstalled. Every change can be undone from this app or the TV's Settings → Apps.
          <button className="btn small ghost palette-open" onClick={() => setPalette(true)} title="Command palette">
            Commands <kbd>Ctrl+K</kbd>
          </button>
          <div className="theme-switch" role="group" aria-label="Appearance">
            {(['system', 'light', 'dark'] as const).map((m: ThemeMode) => (
              <button
                key={m}
                className={theme === m ? 'on' : ''}
                onClick={() => setTheme(m)}
                aria-pressed={theme === m}
                title={m === 'system' ? 'Follow the system theme' : `Always ${m}`}
              >
                {m === 'system' ? 'Auto' : m === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
          <a className="gh-link" href={REPO_URL} target="_blank" rel="noreferrer" title="Source, releases and issues on GitHub">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            <span>wingedpanther/cleanmytv</span>
          </a>
          <div className="gh-ver">CleanMyTV v{version} · MIT</div>
        </div>
      </aside>
      <main className="main" id="main-content" tabIndex={-1}>
        {/* Customise renders its own scroll area and sticky footer. */}
        {step === 'customise' && connected ? (
          <Suspense fallback={<Busy text="Loading this step" />}>{screen}</Suspense>
        ) : (
          <div className="content">
            <div key={step} className="screen">
              <Suspense fallback={<Busy text="Loading this step" />}>{screen}</Suspense>
            </div>
          </div>
        )}
        <LogDrawer />
      </main>
      {palette && <CommandPalette status={status} go={setStep} onClose={() => setPalette(false)} />}
    </div>
  )
}

function ConnPill({ status }: { status: ConnStatus }): ReactNode {
  const p = status.probe
  const [dot, text] =
    status.state === 'connected'
      ? ['ok', p ? `${p.manufacturer} ${p.model}` : status.host ?? 'Connected']
      : status.state === 'connecting'
        ? ['busy', `Connecting to ${status.host ?? 'TV'}`]
        : status.state === 'waiting-auth'
          ? ['busy', 'Waiting for Allow on the TV']
          : status.state === 'error'
            ? ['err', 'Not connected']
            : ['idle', 'No TV connected']
  return (
    <div className="conn-pill" title={status.error ?? status.host}>
      <span className={`dot ${dot}`} />
      <span>{text}</span>
    </div>
  )
}
