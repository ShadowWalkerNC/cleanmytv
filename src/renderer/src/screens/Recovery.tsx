import { useEffect, useState, type ReactNode } from 'react'
import type { ApplyResult, SnapshotDiff, SnapshotSummary } from '@shared/api'
import type { ScreenProps } from '../App'
import { Busy, Confirm, ResultNotice, errorText } from '../components/ui'

export function Recovery({ }: ScreenProps): ReactNode {
  const [snaps, setSnaps] = useState<SnapshotSummary[] | null>(null)
  const [label, setLabel] = useState('')
  const [result, setResult] = useState<ApplyResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [restore, setRestore] = useState<SnapshotSummary | null>(null)
  const [remove, setRemove] = useState<SnapshotSummary | null>(null)
  const [compare, setCompare] = useState<[string, string]>(['', ''])
  const [diff, setDiff] = useState<SnapshotDiff | null>(null)

  const refresh = (): void => {
    window.cytv.listSnapshots().then(setSnaps, () => setSnaps([]))
  }
  useEffect(refresh, [])

  async function run(labelText: string, fn: () => Promise<ApplyResult | void>): Promise<void> {
    setBusy(labelText)
    try {
      const r = await fn()
      if (r) setResult(r)
    } catch (e) {
      setResult({ ok: false, summary: errorText(e), warnings: [] })
    } finally {
      setBusy(null)
      refresh()
    }
  }

  if (!snaps) return <Busy text="Reading snapshots" />

  return (
    <>
      <h1>Recovery Center</h1>
      <p className="lede">
        Named snapshots of the TV's software state: package states, Home, theme, DNS, animations, screensaver. This is
        settings plus app states, not a firmware backup.
      </p>
      <ResultNotice result={result} onDismiss={() => setResult(null)} />
      {busy && (
        <div className="notice">
          <Busy text={busy} />
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Take a snapshot</h2>
        </div>
        <div className="row">
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. before-cleanup" style={{ width: 260 }} />
          <button
            className="btn primary"
            disabled={!!busy}
            onClick={() =>
              run('Taking a snapshot', async () => {
                const s = await window.cytv.createSnapshot(label.trim() || 'snapshot')
                setLabel('')
                return { ok: true, summary: `Snapshot ${s.id}: ${s.packages} packages recorded.`, warnings: [] }
              })
            }
          >
            Take snapshot
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Snapshots ({snaps.length})</h2>
        </div>
        {snaps.length === 0 && <p className="muted">None yet. Take one before any cleanup.</p>}
        {snaps.map((s) => (
          <div key={s.id} className="row between" style={{ padding: '8px 0', borderTop: '1px solid var(--line)' }}>
            <div>
              <b>{s.label}</b> <span className="muted small">{s.id}</span>
              <div className="muted small">
                {new Date(s.created).toLocaleString()} · {s.deviceId} · {s.packages} packages · {s.coverage.join(', ')}
              </div>
            </div>
            <div className="row">
              <button className="btn small ghost" disabled={!!busy} onClick={() => setCompare(([a]) => [a === s.id ? '' : s.id, ''])}>
                {compare[0] === s.id ? 'Picked' : 'Compare'}
              </button>
              <button className="btn small" disabled={!!busy} onClick={() => setRestore(s)}>
                Restore
              </button>
              <button className="btn small ghost" disabled={!!busy} onClick={() => setRemove(s)}>
                Delete
              </button>
            </div>
          </div>
        ))}
        {compare[0] && (
          <div className="row" style={{ marginTop: 10 }}>
            <select value={compare[1]} onChange={(e) => setCompare([compare[0], e.target.value])}>
              <option value="">Compare {compare[0]} with…</option>
              {snaps.filter((s) => s.id !== compare[0]).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} ({s.id})
                </option>
              ))}
            </select>
            <button
              className="btn small"
              disabled={!!busy || !compare[1]}
              onClick={() =>
                run('Comparing snapshots', async () => {
                  setDiff(await window.cytv.diffSnapshots(compare[0], compare[1]))
                })
              }
            >
              Show differences
            </button>
            {diff && diff.a === compare[0] && diff.b === compare[1] && (
              <button className="btn small ghost" onClick={() => { setDiff(null); setCompare(['', '']) }}>
                Clear
              </button>
            )}
          </div>
        )}
      </div>

      {diff && (
        <div className="card">
          <div className="card-head">
            <h2>
              {diff.a} → {diff.b}
            </h2>
          </div>
          {diff.packagesChanged.length === 0 && !diff.homeChanged && diff.settingsChanged.length === 0 && !diff.themeChanged && (
            <p className="muted">No differences.</p>
          )}
          {diff.packagesChanged.length > 0 && (
            <>
              <h3>Packages ({diff.packagesChanged.length})</h3>
              {diff.packagesChanged.slice(0, 100).map((p) => (
                <div key={p.pkg} className="row muted small" style={{ gap: 8 }}>
                  <span style={{ fontFamily: 'monospace' }}>{p.pkg}</span>
                  <span>
                    {p.from} → {p.to}
                  </span>
                </div>
              ))}
              {diff.packagesChanged.length > 100 && <p className="muted small">…and {diff.packagesChanged.length - 100} more.</p>}
            </>
          )}
          {diff.homeChanged && (
            <p>
              Home: <span style={{ fontFamily: 'monospace' }}>{diff.homeChanged.from ?? 'none'}</span> →{' '}
              <span style={{ fontFamily: 'monospace' }}>{diff.homeChanged.to ?? 'none'}</span>
            </p>
          )}
          {diff.settingsChanged.length > 0 && (
            <>
              <h3>Settings</h3>
              {diff.settingsChanged.map((s) => (
                <div key={s.key} className="row muted small" style={{ gap: 8 }}>
                  <span style={{ fontFamily: 'monospace' }}>{s.key}</span>
                  <span>
                    {s.from} → {s.to}
                  </span>
                </div>
              ))}
            </>
          )}
          {diff.themeChanged && <p>Theme config or wallpaper changed.</p>}
        </div>
      )}

      {restore && (
        <Confirm title={`Restore ${restore.label}?`} confirmLabel="Restore" onCancel={() => setRestore(null)} onConfirm={() => {
          const id = restore.id
          setRestore(null)
          run(`Restoring ${id}`, () => window.cytv.restoreSnapshot(id))
        }}>
          <p>
            Packages, Home, theme, DNS, animations and screensaver go back to {new Date(restore.created).toLocaleString()}. Only
            onto the same TV the snapshot was taken from.
          </p>
        </Confirm>
      )}

      {remove && (
        <Confirm title={`Delete ${remove.label}?`} confirmLabel="Delete" onCancel={() => setRemove(null)} onConfirm={() => {
          const id = remove.id
          setRemove(null)
          run('Deleting the snapshot', async () => {
            await window.cytv.deleteSnapshot(id)
          })
        }}>
          <p>The snapshot files leave this computer. The TV is untouched.</p>
        </Confirm>
      )}
    </>
  )
}
