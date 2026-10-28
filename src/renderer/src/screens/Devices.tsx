import { useEffect, useState, type ReactNode } from 'react'
import type { ApplyResult, Capability, ManagedDevice } from '@shared/api'
import type { ScreenProps } from '../App'
import { Busy, Confirm, ResultNotice, errorText } from '../components/ui'

export function Devices({ status }: ScreenProps): ReactNode {
  const [devices, setDevices] = useState<ManagedDevice[] | null>(null)
  const [caps, setCaps] = useState<Capability[] | null>(null)
  const [result, setResult] = useState<ApplyResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [forget, setForget] = useState<ManagedDevice | null>(null)
  const connected = status.state === 'connected'

  const refresh = (): void => {
    window.cytv.listDevices().then(setDevices, () => setDevices([]))
    if (connected) window.cytv.deviceCapabilities().then(setCaps, () => setCaps([]))
    else setCaps(null)
  }
  useEffect(refresh, [connected])

  async function run(label: string, fn: () => Promise<ApplyResult | void>): Promise<void> {
    setBusy(label)
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

  function downloadReport(): void {
    run('Building the capability report', async () => {
      const report = await window.cytv.capabilityReport()
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `cleanmytv-capabilities-${report.deviceId}.json`
      a.click()
      URL.revokeObjectURL(a.href)
      return { ok: true, summary: 'Report downloaded (no addresses or keys inside).', warnings: [] }
    })
  }

  if (!devices) return <Busy text="Reading the device registry" />

  return (
    <>
      <h1>Devices</h1>
      <p className="lede">Every TV this app has talked to. Identity is the TV itself, never its address.</p>
      <ResultNotice result={result} onDismiss={() => setResult(null)} />
      {busy && (
        <div className="notice">
          <Busy text={busy} />
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Known TVs ({devices.length})</h2>
        </div>
        {devices.length === 0 && <p className="muted">None yet. Connect a TV from Setup and it registers here.</p>}
        {devices.map((d) => (
          <div key={d.id} className="row between" style={{ padding: '8px 0', borderTop: '1px solid var(--line)' }}>
            <div>
              <b>
                {d.identity.manufacturer ?? ''} {d.identity.model ?? d.id}
              </b>{' '}
              <span className={`chip ${d.state === 'connected' ? 'ok' : 'optional'}`}>{d.state}</span>
              <div className="muted small">
                {d.id} · {d.capabilities.length} capabilities · last seen {new Date(d.lastSeen).toLocaleString()}
                {d.lastAddress && d.state !== 'connected' ? ` · was at ${d.lastAddress}` : ''}
              </div>
            </div>
            <div className="row">
              {d.state !== 'connected' && d.lastAddress && (
                <button
                  className="btn small"
                  disabled={!!busy}
                  onClick={() =>
                    run(`Connecting to ${d.lastAddress}`, async () => {
                      const s = await window.cytv.connect(d.lastAddress!)
                      return s.state === 'connected'
                        ? { ok: true, summary: `Connected to ${d.lastAddress}.`, warnings: [] }
                        : { ok: false, summary: s.error ?? 'Could not connect.', warnings: [] }
                    })
                  }
                >
                  Connect
                </button>
              )}
              <button className="btn small ghost" disabled={!!busy} onClick={() => setForget(d)}>
                Forget
              </button>
            </div>
          </div>
        ))}
      </div>

      {connected && (
        <div className="card">
          <div className="card-head">
            <h2>This TV can</h2>
            <button className="btn small" disabled={!!busy} onClick={downloadReport}>
              Download report
            </button>
          </div>
          {!caps && <Busy text="Probing capabilities" />}
          {caps?.map((c) => (
            <div key={c.id} className="row between" style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
              <div>
                <b>{c.label}</b>
                {c.detail && <div className="muted small">{c.detail}</div>}
              </div>
              <span className={`chip ${c.supported ? 'ok' : 'optional'}`}>{c.supported ? 'Yes' : 'No'}</span>
            </div>
          ))}
          <p className="muted small" style={{ marginTop: 10 }}>
            Screens hide what the TV cannot do instead of failing. The report carries no addresses or keys.
          </p>
        </div>
      )}

      {forget && (
        <Confirm title={`Forget ${forget.identity.model ?? forget.id}?`} confirmLabel="Forget" onCancel={() => setForget(null)} onConfirm={() => {
          const id = forget.id
          setForget(null)
          run('Forgetting the TV', async () => {
            await window.cytv.removeDevice(id)
          })
        }}>
          <p>Removes it from the registry. Snapshots and recovery records stay on this computer.</p>
        </Confirm>
      )}
    </>
  )
}
