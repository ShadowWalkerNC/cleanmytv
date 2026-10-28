import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { LauncherConfig, TvApp } from '@shared/api'
import { appColour, homeLayout, monogram, val } from '../lib/apps'

/** A sketch of the launcher's Home at 16:9, in container units so it scales with the panel. */
export function TvPreview(props: { apps: TvApp[]; cfg: LauncherConfig; wallpaper: string | null }): ReactNode {
  const { cfg, apps } = props
  const now = useNow()
  const [focus, setFocus] = useState(0)
  const layout = useMemo(() => homeLayout(apps, cfg), [apps, cfg])
  const cols = Math.max(1, val(cfg, 'columns'))
  const rowsBelow = val(cfg, 'rows_below_dock')
  const dockRow = val(cfg, 'dock_row')
  const dockTitle = val(cfg, 'dock_title')
  const showStats = val(cfg, 'show_stats')
  const bg = val(cfg, 'background_color')
  const dim = val(cfg, 'wallpaper_dim')
  const sky = val(cfg, 'sky_intensity')
  const wallpaperOn = val(cfg, 'wallpaper')
  const festival = festivalActive(cfg, now)

  const tiles = layout.dock
  const focused = tiles[Math.min(focus, tiles.length - 1)] ?? null
  const glow = festival ? cfg.accent_color || '#FFB23C' : focused ? appColour(focused.pkg) : '#333'

  // Geometry in cqw (1 = 1% of the screen width). Tiles shrink from 5 columns up, like the launcher.
  const inner = 92 - 2.2
  const gap = 1.1
  const tileW = Math.min((inner - gap * (cols - 1)) / cols, cols <= 4 ? 21 : 100)
  const tileH = (tileW * 9) / 16
  const gridRowH = tileH + 3.4
  const dockBottom = 3.2 + rowsBelow * gridRowH
  const dockHeight = tileH + 2.2
  const heroBottom = dockBottom + dockHeight + 1.6

  const greet = festival && cfg.greeting ? cfg.greeting : greetingFor(now)
  const name = val(cfg, 'greeting_name')

  return (
    <div className="tv-frame">
      <div className="tv-screen" style={{ background: bg }}>
        {wallpaperOn && props.wallpaper && (
          <>
            <div className="tv-layer tv-wall" style={{ backgroundImage: `url(${props.wallpaper})` }} />
            {dim > 0 && <div className="tv-layer" style={{ background: `rgba(0,0,0,${dim / 100})` }} />}
          </>
        )}
        {sky > 0 && <div className="tv-layer" style={{ background: skyGradient(now), opacity: sky / 100 }} />}
        <div className="tv-glow" style={{ background: `radial-gradient(ellipse at 30% 100%, ${glow}, transparent 65%)`, bottom: '-20%' }} />

        <div className="tv-top">
          <div>
            <div className="tv-greet">
              {greet}
              {name ? `, ${name}` : ''}
            </div>
            <div className="tv-clock">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</div>
            <div className="tv-date">
              {val(cfg, 'shamsi_date') && <span>27 Mehr 1405 · </span>}
              {now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}
            </div>
            {showStats && <div className="tv-stats">CPU 12% · 1.1 GB free · 5.2 GB storage</div>}
          </div>
          <div className="tv-pills">
            {cfg.reorder_button && <span className="tv-pill">⇅</span>}
            <span className="tv-pill">{festival ? '🔔 ' : ''}Inputs</span>
            <span className="tv-pill">{festival ? '🪔 ' : ''}Wi-Fi</span>
            <span className="tv-pill">{festival ? '🌼 ' : ''}Settings</span>
          </div>
        </div>

        {dockTitle && focused && (
          <div className="tv-hero" style={{ bottom: `${heroBottom}cqw` }}>
            {focused.label}
          </div>
        )}

        <div className={`tv-dock${dockRow ? ' band' : ''}`} style={{ bottom: `${dockBottom}cqw` }}>
          <div className="tv-row" style={{ gridTemplateColumns: `repeat(${cols}, ${tileW}cqw)`, gap: `${gap}cqw` }}>
            {tiles.map((a, i) =>
              a ? (
                <Tile key={a.pkg} app={a} focus={i === focus} named={!dockRow} onClick={() => setFocus(i)} />
              ) : (
                <div key={`empty-${i}`} className="tv-tile" style={{ border: '0.2cqw dashed rgba(255,255,255,0.2)' }} />
              )
            )}
          </div>
        </div>

        {rowsBelow > 0 && (
          <div className="tv-grid" style={{ bottom: `${dockBottom - rowsBelow * gridRowH - 3.4 - 1.5}cqw` }}>
            {Array.from({ length: rowsBelow }, (_, r) => (
              <div
                key={r}
                className="tv-row"
                style={{ gridTemplateColumns: `repeat(${cols}, ${tileW}cqw)`, gap: `${gap}cqw`, marginBottom: '3.4cqw' }}
              >
                {layout.grid.slice(r * cols, (r + 1) * cols).map((a) => (
                  <Tile key={a.pkg} app={a} named />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Tile({ app, focus, named, onClick }: { app: TvApp; focus?: boolean; named?: boolean; onClick?: () => void }): ReactNode {
  const style: CSSProperties = { background: appColour(app.pkg), cursor: onClick ? 'pointer' : undefined }
  return (
    <div className={`tv-tile${focus ? ' focus' : ''}`} style={style} onClick={onClick} title={app.label}>
      {monogram(app.label)}
      {named && <span className="tv-tile-name">{app.label}</span>}
    </div>
  )
}

function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])
  return now
}

function greetingFor(d: Date): string {
  const h = d.getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

function festivalActive(cfg: LauncherConfig, now: Date): boolean {
  if (!cfg.festival) return false
  if (!cfg.festival_until) return true
  const until = new Date(`${cfg.festival_until}T23:59:59`)
  return !Number.isNaN(until.getTime()) && now <= until
}

/** Rough take on the launcher's Sky: night blues, a soft blue day, a warm horizon in the evening. */
function skyGradient(d: Date): string {
  const h = d.getHours() + d.getMinutes() / 60
  if (h < 5 || h >= 21.5) return 'linear-gradient(180deg, #050a1c 0%, #0b1838 70%, #12204a 100%)'
  if (h < 7.5) return 'linear-gradient(180deg, #101a3a 0%, #3a3050 65%, #7a4a3a 100%)'
  if (h < 17) return 'linear-gradient(180deg, #0e2a4a 0%, #1d4a70 70%, #2c5d84 100%)'
  return 'linear-gradient(180deg, #121a3a 0%, #4a2a48 60%, #a2512e 100%)'
}
