import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Capability, ConnStatus } from '@shared/api'
import type { StepId } from '../lib/steps'
import { COMMANDS, filterCommands, type Command } from '../lib/commands'
import { Busy, Confirm, Modal, ResultNotice, errorText } from './ui'

export function CommandPalette(props: { status: ConnStatus; go: (step: StepId) => void; onClose: () => void }): ReactNode {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [caps, setCaps] = useState<Capability[] | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [result, setResult] = useState<{ ok: boolean; summary: string } | null>(null)
  const [confirm, setConfirm] = useState<Command | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const connected = props.status.state === 'connected'

  useEffect(() => {
    inputRef.current?.focus()
    if (connected) window.cytv.deviceCapabilities().then(setCaps, () => setCaps([]))
    else setCaps(null)
  }, [connected])

  const supported = useMemo(
    () => new Set((caps ?? []).filter((c) => c.supported).map((c) => c.id)),
    [caps]
  )
  /** Why this command is unavailable right now, or null when it can run. */
  const gated = (c: Command): string | null => {
    if (c.needsTv && !connected) return 'Connect a TV first'
    if (c.capability && caps && !supported.has(c.capability)) return 'This TV cannot do this'
    return null
  }
  const list = useMemo(() => filterCommands(COMMANDS, query), [query])
  useEffect(() => setIndex(0), [query])

  async function run(cmd: Command): Promise<void> {
    if (gated(cmd)) return
    if (cmd.run.kind === 'go') {
      props.onClose()
      props.go(cmd.run.step)
      return
    }
    setRunning(cmd.run.label)
    setResult(null)
    try {
      setResult(await cmd.run.fn())
    } catch (e) {
      setResult({ ok: false, summary: errorText(e) })
    } finally {
      setRunning(null)
    }
  }

  function choose(cmd: Command | undefined): void {
    if (!cmd || running || gated(cmd)) return
    if (cmd.danger) {
      setConfirm(cmd)
      return
    }
    void run(cmd)
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => Math.min(i + 1, list.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(list[index])
    }
  }

  if (confirm) {
    const cmd = confirm
    return (
      <Confirm
        title={cmd.confirmTitle ?? cmd.title}
        confirmLabel={cmd.confirmLabel ?? 'Run'}
        danger={cmd.danger}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null)
          void run(cmd)
        }}
      >
        <p>{cmd.hint}</p>
      </Confirm>
    )
  }

  return (
    <Modal label="Command palette" onClose={props.onClose}>
      <input
        ref={inputRef}
        type="search"
        className="palette-input"
        placeholder="Type a command…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
        role="combobox"
        aria-expanded
        aria-controls="palette-list"
        aria-activedescendant={list[index] ? `palette-${list[index].id}` : undefined}
      />
      {running && <Busy text={running} />}
      {result && (
        <ResultNotice
          result={{ ok: result.ok, summary: result.summary, warnings: [] }}
          onDismiss={() => setResult(null)}
        />
      )}
      <ul id="palette-list" role="listbox" aria-label="Commands" className="palette-list">
        {list.map((c, i) => {
          const why = gated(c)
          return (
            <li
              key={c.id}
              id={`palette-${c.id}`}
              role="option"
              aria-selected={i === index}
              aria-disabled={!!why}
              className={`palette-item${i === index ? ' active' : ''}${why ? ' gated' : ''}`}
              onClick={() => choose(c)}
              onMouseMove={() => {
                if (i !== index) setIndex(i)
              }}
            >
              <span className="palette-title">
                {c.title}
                {c.danger && <span className="chip missing">careful</span>}
              </span>
              <span className="muted small">{why ?? c.hint}</span>
            </li>
          )
        })}
        {list.length === 0 && (
          <li className="muted" style={{ padding: '8px 4px' }}>
            No command matches.
          </li>
        )}
      </ul>
    </Modal>
  )
}
