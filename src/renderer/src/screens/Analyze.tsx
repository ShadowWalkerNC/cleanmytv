import { useEffect, useState, type ReactNode } from 'react'
import type { FixReport, TvAnalysis } from '@shared/api'
import type { ScreenProps } from '../App'
import { suggestNextStep } from '../lib/commands'
import { Busy, ResultNotice, errorText } from '../components/ui'

function gb(kb: number): string {
  return `${(kb / 1024 / 1024).toFixed(1)} GB`
}

export function Analyze({ go }: ScreenProps): ReactNode {
  const [analysis, setAnalysis] = useState<TvAnalysis | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [report, setReport] = useState<FixReport | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = (): void => {
    setFailed(null)
    window.cytv.analyzeTv().then(setAnalysis, (e) => setFailed(errorText(e)))
  }
  useEffect(refresh, [])

  function fix(): void {
    setBusy('Fixing your TV: snapshot, cleanup, fast settings')
    window.cytv
      .fixTv()
      .then((r) => {
        setReport(r)
        refresh()
      })
      .catch((e: unknown) => setReport({ ok: false, summary: errorText(e), warnings: [], snapshotId: null, metrics: { packagesDisabled: 0, animationsFrom: '', animationsTo: '', storageAvailBeforeKb: 0, storageAvailAfterKb: 0 } }))
      .finally(() => setBusy(null))
  }

  if (failed) {
    return (
      <>
        <h1>Analyze</h1>
        <div className="notice warn">
          <p>{failed}</p>
          <button className="btn small" onClick={refresh}>
            Try again
          </button>
        </div>
      </>
    )
  }
  if (!analysis) return <Busy text="Analyzing your TV" />

  const good = analysis.adsClutter.level === 'Low' && analysis.performance.status === 'Good' && !analysis.storage.low
  const suggestion = good ? null : suggestNextStep(analysis)
  const usedPct = analysis.storage.totalKb > 0 ? Math.round((1 - analysis.storage.availKb / analysis.storage.totalKb) * 100) : 0

  return (
    <>
      <h1>{good ? 'Your TV looks good' : 'Your TV can be improved'}</h1>
      <p className="lede">
        Checked against {analysis.listTitle}. {analysis.adsClutter.enabledBloat} of {analysis.adsClutter.totalListed} listed apps
        still on.
      </p>
      {suggestion && (
        <div className="card white">
          <div className="card-head">
            <div>
              <h2 style={{ marginBottom: 4 }}>Suggested next step</h2>
              <p className="muted" style={{ margin: 0 }}>
                {suggestion.reason}
              </p>
            </div>
            <button className="btn primary" onClick={() => go(suggestion.step)}>
              {suggestion.title}
            </button>
          </div>
        </div>
      )}
      {busy && (
        <div className="notice">
          <Busy text={busy} />
        </div>
      )}
      {report && (
        <ResultNotice
          result={{ ok: report.ok, summary: report.summary, warnings: report.warnings }}
          onDismiss={() => setReport(null)}
        />
      )}
      {report?.ok && (
        <div className="notice ok">
          <p>
            Measured: {report.metrics.packagesDisabled} apps switched off, animations {report.metrics.animationsFrom || 'default'}x
            → {report.metrics.animationsTo}x
            {report.metrics.storageAvailAfterKb !== report.metrics.storageAvailBeforeKb &&
              `, free storage ${gb(report.metrics.storageAvailBeforeKb)} → ${gb(report.metrics.storageAvailAfterKb)}`}
            . Recovery point {report.snapshotId ?? '(none)'}.
          </p>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Health</h2>
        </div>
        <div className="row between" style={{ padding: '6px 0' }}>
          <b>Ads &amp; clutter</b>
          <span className={`chip ${analysis.adsClutter.level === 'Low' ? 'ok' : analysis.adsClutter.level === 'Medium' ? 'warn' : 'missing'}`}>
            {analysis.adsClutter.level}
          </span>
        </div>
        <div className="row between" style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
          <div>
            <b>Performance</b>
            {analysis.performance.reasons.map((r) => (
              <div key={r} className="muted small">
                {r}
              </div>
            ))}
          </div>
          <span className={`chip ${analysis.performance.status === 'Good' ? 'ok' : 'warn'}`}>{analysis.performance.status}</span>
        </div>
        <div className="row between" style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
          <div>
            <b>Privacy</b>
            <div className="muted small">{analysis.privacy.detail}</div>
          </div>
          <span className="chip optional">Not scanned</span>
        </div>
        <div className="row between" style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
          <div>
            <b>Storage</b>
            <div className="muted small">
              {analysis.storage.totalKb > 0 ? `${gb(analysis.storage.availKb)} free of ${gb(analysis.storage.totalKb)}` : 'The TV did not answer.'}
            </div>
            {analysis.storage.totalKb > 0 && (
              <div style={{ height: 6, borderRadius: 3, background: 'var(--line)', marginTop: 6, width: 220 }}>
                <div style={{ height: 6, borderRadius: 3, width: `${usedPct}%`, background: analysis.storage.low ? 'var(--danger)' : 'var(--accent)' }} />
              </div>
            )}
          </div>
          <span className={`chip ${analysis.storage.low ? 'missing' : 'ok'}`}>{analysis.storage.low ? 'Low' : 'OK'}</span>
        </div>
        <div className="row between" style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
          <div>
            <b>Launcher</b>
            <div className="muted small" style={{ fontFamily: 'monospace' }}>
              {analysis.launcher.home ?? 'none recorded'}
            </div>
          </div>
          <span className={`chip ${analysis.launcher.isClean ? 'ok' : 'optional'}`}>{analysis.launcher.isClean ? 'Clean' : 'Stock'}</span>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Fix My TV</h2>
        </div>
        {analysis.recommendations.map((r) => (
          <div key={r} className="muted" style={{ padding: '2px 0' }}>
            • {r}
          </div>
        ))}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn primary" disabled={!!busy} onClick={fix}>
            Fix My TV
          </button>
          <button className="btn ghost" disabled={!!busy} onClick={refresh}>
            Re-check
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          Recovery point will be created automatically. Cleanup runs with all safety guards; launcher installs stay a
          deliberate step.
        </p>
      </div>
    </>
  )
}
