import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type { ApplyResult, CheckStatus } from '@shared/api'

export function Toggle(props: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}): ReactNode {
  return (
    <label className="toggle" style={props.disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span className="toggle-switch" />
      <span className="toggle-text">
        <b>{props.label}</b>
        {props.hint && <span>{props.hint}</span>}
      </span>
    </label>
  )
}

const chipText: Record<CheckStatus, string> = {
  ok: 'Ready',
  missing: 'Needed',
  warn: 'Check',
  optional: 'Optional',
  checking: 'Checking'
}

export function StatusChip({ status, text }: { status: CheckStatus; text?: string }): ReactNode {
  return <span className={`chip ${status}`}>{text ?? chipText[status]}</span>
}

export function Modal(props: { children: ReactNode; onClose: () => void; wide?: boolean; label: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const close = props.onClose
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusables = (): HTMLElement[] =>
      Array.from(
        node.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex >= 0)
    // Respect an autoFocused child; otherwise land on the first control (or the dialog itself).
    if (!node.contains(document.activeElement)) {
      const first = focusables()
      if (first.length) first[0].focus()
      else node.focus()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        close()
        return
      }
      if (e.key !== 'Tab') return
      const f = focusables()
      if (!f.length) {
        e.preventDefault()
        return
      }
      const first = f[0]
      const last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    node.addEventListener('keydown', onKey)
    return () => {
      node.removeEventListener('keydown', onKey)
      prev?.focus()
    }
  }, [close])
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div
        ref={ref}
        tabIndex={-1}
        className={`modal${props.wide ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
      >
        {props.children}
      </div>
    </div>
  )
}

export function Confirm(props: {
  title: string
  children: ReactNode
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  /** Destructive action: focus lands on Cancel and the confirm button turns red. */
  danger?: boolean
}): ReactNode {
  return (
    <Modal onClose={props.onCancel} label={props.title}>
      <h2>{props.title}</h2>
      <div>{props.children}</div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={props.onCancel} autoFocus={props.danger || undefined}>
          Cancel
        </button>
        <button
          className={`btn primary${props.danger ? ' danger' : ''}`}
          onClick={props.onConfirm}
          autoFocus={props.danger ? undefined : true}
        >
          {props.confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

export function ResultNotice({ result, onDismiss }: { result: ApplyResult | null; onDismiss?: () => void }): ReactNode {
  if (!result) return null
  const kind = !result.ok ? 'error' : result.warnings.length ? 'warn' : 'ok'
  return (
    <div className={`notice ${kind}`} role="status">
      <div className="row between">
        <b>{result.summary}</b>
        {onDismiss && (
          <button className="icon-btn" onClick={onDismiss} aria-label="Dismiss">
            ✕
          </button>
        )}
      </div>
      {result.warnings.length > 0 && (
        <ul>
          {result.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function Busy({ text }: { text: string }): ReactNode {
  return (
    <div className="row muted">
      <span className="spinner" />
      <span>{text}</span>
    </div>
  )
}

export interface StepState {
  label: string
  state: 'todo' | 'active' | 'done' | 'skipped'
  detail?: string
}

/** Honest multi-phase progress: every row reflects a step that really ran, runs, or was skipped. */
export function StepProgress({ steps }: { steps: StepState[] }): ReactNode {
  return (
    <ol className="steps-progress" aria-label="Progress">
      {steps.map((s) => (
        <li key={s.label} className={`sp-${s.state}`} aria-current={s.state === 'active' ? 'step' : undefined}>
          <span className="sp-dot" aria-hidden>
            {s.state === 'done' ? '✓' : s.state === 'skipped' ? '–' : ''}
          </span>
          <span className="sp-label">
            {s.label}
            {s.detail && <span className="sp-detail">{s.detail}</span>}
          </span>
          {s.state === 'active' && <span className="spinner" />}
        </li>
      ))}
    </ol>
  )
}

export function Slider(props: {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (v: number) => void
}): ReactNode {
  return (
    <label className="field">
      <span>{props.label}</span>
      {props.hint && <span className="hint">{props.hint}</span>}
      <div className="slider-field">
        <input
          type="range"
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          value={props.value}
          onChange={(e) => props.onChange(Number(e.target.value))}
        />
        <output>
          {props.value}
          {props.unit ?? ''}
        </output>
      </div>
    </label>
  )
}

export function Tabs<T extends string>(props: {
  tabs: readonly (readonly [T, string])[]
  value: T
  onChange: (v: T) => void
  className: string
  label: string
  /** 'tab' switches panels; 'radio' picks one filter (single-select semantics). */
  variant?: 'tab' | 'radio'
  /** Id base wiring tabs to their panel (`${panelId}-tab-*` / `${panelId}-panel`). */
  panelId?: string
}): ReactNode {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const variant = props.variant ?? 'tab'
  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number): void => {
    let next: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % props.tabs.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + props.tabs.length) % props.tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = props.tabs.length - 1
    if (next === null) return
    e.preventDefault()
    props.onChange(props.tabs[next][0])
    refs.current[next]?.focus()
  }
  return (
    <div className={props.className} role={variant === 'tab' ? 'tablist' : 'radiogroup'} aria-label={props.label}>
      {props.tabs.map(([id, label], i) => (
        <button
          key={id}
          ref={(el) => {
            refs.current[i] = el
          }}
          role={variant === 'tab' ? 'tab' : 'radio'}
          id={props.panelId ? `${props.panelId}-tab-${id}` : undefined}
          aria-selected={variant === 'tab' ? props.value === id : undefined}
          aria-checked={variant === 'radio' ? props.value === id : undefined}
          aria-controls={variant === 'tab' && props.panelId ? `${props.panelId}-panel` : undefined}
          tabIndex={props.value === id ? 0 : -1}
          className={props.value === id ? 'on' : ''}
          onClick={() => props.onChange(id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/** Runs an async action with a busy flag and an error turned into an ApplyResult. */
export async function attempt<T>(fn: () => Promise<T>): Promise<T | ApplyResult> {
  try {
    return await fn()
  } catch (e) {
    return { ok: false, summary: errorText(e), warnings: [] }
  }
}

export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  // Electron prefixes errors thrown in the main process.
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function NotConnected({ onGo }: { onGo: () => void }): ReactNode {
  return (
    <div className="empty">
      <div className="tv-glyph" />
      <h2>Connect to your TV first</h2>
      <p className="muted">This step reads and changes things on the TV, so it needs the connection from Setup.</p>
      <button className="btn primary" onClick={onGo}>
        Go to Setup
      </button>
    </div>
  )
}
