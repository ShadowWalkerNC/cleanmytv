// The contract between the main process (talks to the TV) and the renderer (the UI).
// Every call goes through window.cytv, which the preload script builds from this interface.

export type PackageState = 'enabled' | 'disabled' | 'absent'

export interface Probe {
  host: string
  model: string
  device: string
  product: string
  manufacturer: string
  /** Android version, e.g. "11". */
  release: string
  sdk: number
  build: string
  /** "0" means port 5555 accepts any device on the network without the Allow prompt. */
  adbSecure: string
}

export type ConnState = 'idle' | 'connecting' | 'waiting-auth' | 'connected' | 'error'

export interface ConnStatus {
  state: ConnState
  host?: string
  /** Plain-language reason when state is error. */
  error?: string
  /** The port answered but asked for TLS: Wireless debugging needs a one-time pairing. */
  needsPairing?: boolean
  /**
   * Set by reconnect: the saved TV is not (or no longer) at the saved address. The user picks it from a
   * scan; the app never handshakes with scanned devices on its own.
   */
  moved?: boolean
  probe?: Probe
}

export interface ScanHit {
  host: string
}

export type CheckStatus = 'ok' | 'missing' | 'warn' | 'optional' | 'checking'

export interface CheckItem {
  id: 'network' | 'tv' | 'auth' | 'apk' | 'jdk' | 'sdk' | 'source' | 'platform-tools'
  label: string
  status: CheckStatus
  detail: string
  /** A download the app can do for the user, by ToolId. */
  download?: ToolId
}

export type ToolId = 'jdk' | 'sdk' | 'source' | 'platform-tools'

export interface DebloatListSummary {
  /** Folder name in upstream examples/, or "custom". */
  id: string
  /** First header line of the list, without the leading "# ". */
  title: string
  /** Higher is a better match for the connected TV; 0 = no match. */
  score: number
}

export interface DebloatEntry {
  pkg: string
  /** The list's inline comment for this package. */
  note: string
  /** In the list as an active line (true) or commented out by the author (false). */
  suggested: boolean
  /** Live state on the TV; absent when the package is not installed. */
  state: PackageState
  /** State in the recovery record, when one exists for this TV and list. */
  recorded?: PackageState
  /** How many of the upstream lists disable this package. */
  common: number
  /**
   * Set when switching this package off loses something people use (the phone remote, casting, voice)
   * or the list puts it under "Personal choice"/"Optional": not ticked unless the user ticks it.
   */
  choice?: string
}

export interface DebloatPlan {
  listId: string
  title: string
  header: string[]
  entries: DebloatEntry[]
  /** Recovery record for this TV and list, if one was written earlier. */
  record?: { path: string; created: string }
  /** Package that owns Home right now. */
  homePackage: string | null
}

export interface DebloatApplyRequest {
  listId: string
  /** Packages to disable, from the plan's entries. */
  disable: string[]
  /** Packages to switch back on now (unticked after an earlier run). */
  enable: string[]
  forceHome?: boolean
  forceSetupwraith?: boolean
  /** Disable packages that drive the HDMI/AV inputs anyway (upstream TVINPUT_ALLOW=1). */
  forceTvInput?: boolean
  /** Disable packages that open the TV's inputs and Settings anyway (upstream HANDLERS_ALLOW=1). */
  forceHandlers?: boolean
}

export interface ApplyResult {
  ok: boolean
  /** One line for the user. */
  summary: string
  /** Things that were skipped or need the user's attention. */
  warnings: string[]
}

export interface LauncherStatus {
  installed: boolean
  versionName?: string
  isHome: boolean
  homeComponent: string | null
  /** The stock launcher package found on the TV, if any. */
  stockLauncher: string | null
  bundledApk: boolean
  bundledVersion?: string
  localApk: boolean
}

export interface InstallRequest {
  apk: 'bundled' | 'local'
  /** 'auto' asks the TV; 'none' leaves the stock launcher enabled. */
  stockLauncher: 'auto' | 'none' | string
  inputKeyService: boolean
  homeKeyService: boolean
  /** Uninstall a launcher signed with a different key before installing (loses on-TV order). */
  replaceIncompatible?: boolean
  /** Grant WRITE_SECURE_SETTINGS so Home puts the key helpers back after a force stop (upstream RESTORE_KEY_SERVICES=1). */
  restoreKeyServices?: boolean
}

export interface InstallResult extends ApplyResult {
  /** The installed launcher was signed with another key; ask before replacing it. */
  incompatible?: boolean
}

export interface TvApp {
  pkg: string
  label: string
  /** True for apps with a TV (leanback) entry; false for phone apps the launcher only shows from the library. */
  tv: boolean
}

/** The keys from upstream themes/README.md. Every one is optional. */
export interface LauncherConfig {
  dock_apps?: string[]
  fill_dock?: boolean
  hidden_apps?: string[]
  live_tv_package?: string
  live_tv_action?: string
  source_panel_service?: string
  source_panel_action?: string
  input_action?: string
  columns?: number
  rows_below_dock?: number
  dock_title?: boolean
  dock_row?: boolean
  reorder_button?: boolean
  app_library?: boolean
  shamsi_date?: boolean
  greeting_name?: string
  module_cards?: boolean
  reduced_motion?: boolean
  vpn_app?: string
  animations?: boolean
  advanced_effects?: boolean
  show_home_settings_shortcut?: boolean
  show_stats?: boolean
  background_color?: string
  sky_intensity?: number
  wallpaper?: boolean
  wallpaper_rotation_minutes?: number
  wallpaper_dim?: number
  festival?: string
  festival_until?: string
  greeting?: string
  accent_color?: string
  settings_key_keycodes?: number[]
  settings_key_panel?: boolean
  input_key_keycodes?: number[]
  app_keys?: string[]
  // Keys added with the v3 launcher line (upstream themes/README.md). Every one is optional.
  live_tv_input_id?: string
  source_panel_extra?: string
  coocaa_sources?: boolean
  launch_actions?: string[]
  app_labels?: string[]
  app_banners?: string[]
  input_uri_scheme?: string
  input_sources?: string[]
  show_network_pill?: boolean
  top_bar_apps?: string[]
  show_inputs_pill?: boolean
  top_menu?: boolean
  launcher_settings_button?: boolean
  wifi_status_color?: boolean
  wifi_status_warnings?: boolean
  wifi_label_width?: number
  library_button?: boolean
  show_library_pill?: boolean
  always_show_names?: boolean
  uniform_tiles?: boolean
  app_library_selection?: boolean
  library_ok_opens?: boolean
  library_apps?: string[]
  lunar_date?: boolean
  lunar_utc_offset?: number
  date_below_clock?: boolean
  locale?: string
  show_greeting?: boolean
  header_white?: boolean
  boot_to_live_tv?: boolean
  open_on_start_choice?: boolean
  vpn_pill?: boolean
  handle_view_inputs?: boolean
  clock_wallpaper?: boolean
  clock_wallpaper_dim?: number
  clock_glow?: boolean
  glow_style?: string
  glass_style?: string
  cinematic_home?: boolean
  cinematic_dots?: boolean
  cinematic_white_focus?: boolean
  cinematic_scrim?: number
  cinematic_art?: number
  dock_even_padding?: boolean
  dock_glass?: boolean
  dock_band?: boolean
  single_row?: boolean
  dock_band_all?: boolean
  ambient_glow?: boolean
  app_glow?: boolean
  fade_rows?: boolean
  focus_overshoot?: boolean
  wallpaper_order?: string
  wallpaper_captions?: boolean
  wallpaper_true_color?: boolean
  wallpaper_moods?: Record<string, string[]>
  dock_opacity?: number
  icon_only_buttons?: boolean
  icon_only_inputs?: boolean
  tile_menu?: boolean
  key_filter?: boolean
  gamepad_passthrough?: boolean
  consume_volume_keys?: boolean
  stock_home_redirect?: string
  power_on_home?: boolean
  home_long_press_home?: boolean
  power_on_home_always?: boolean
  inputs_connected_only?: boolean
  race_calendar?: Array<Record<string, unknown>>
  home_idle_clock_minutes?: number
  restore_key_services?: boolean
}

export interface TvTheme {
  config: LauncherConfig
  /** config.json was on the TV. */
  present: boolean
  /** wallpaper.jpg on the TV, as a data URL, or null. */
  wallpaper: string | null
  /** File names in the TV's wallpapers/ folder. */
  wallpapers: string[]
}

export interface ImageFile {
  name: string
  /** JPEG bytes, base64, already sized for the TV by the renderer. */
  base64: string
}

export interface ThemeApplyRequest {
  config: LauncherConfig
  wallpaper: { kind: 'keep' } | { kind: 'remove' } | { kind: 'set'; image: ImageFile }
  wallpapers: { kind: 'keep' } | { kind: 'set'; images: ImageFile[] }
}

export interface ThemePreset {
  id: string
  name: string
  description: string
  config: LauncherConfig
  /** Data URL of the preset's wallpaper.jpg, if it has one. */
  wallpaper: string | null
  /** Rotation pictures from the preset's wallpapers/ folder, if it has one. */
  wallpapers: ImageFile[]
}

export interface SystemState {
  sdk: number
  screensaverIsClock: boolean
  privateDnsMode: string
  privateDnsHost: string
  /** window_animation_scale; "null" when never set. */
  animationScale: string
}

export interface DownloadProgress {
  tool: ToolId
  received: number
  total: number
  phase: 'download' | 'extract' | 'install' | 'done' | 'error'
  message?: string
}

export interface LogLine {
  /** Which job wrote it: 'debloat', 'restore', 'install', 'theme', 'build', 'pair', 'system'. */
  task: string
  level: 'info' | 'cmd' | 'warn' | 'error' | 'ok'
  text: string
  time: number
}

/** A download for the background sources, made by the main process. */
export interface WebResponse {
  status: number
  contentType: string
  base64: string
}

/** One TV (later: display) the app knows. Identity is the device itself, never its address. */
export interface ManagedDevice {
  /** Stable id: `adb-<android_id>`; `adb-<device-slug>` when the id is unreadable. */
  id: string
  provider: 'adb'
  identity: {
    androidId?: string
    device?: string
    model?: string
    manufacturer?: string
    build?: string
  }
  /** Capability ids probed as supported (see Capability). */
  capabilities: string[]
  state: 'connected' | 'known'
  lastSeen: string
  /** Last address it answered at: a reconnect hint only, never identity. */
  lastAddress?: string
}

export interface Capability {
  id: string
  label: string
  supported: boolean
  detail?: string
}

/** Sanitized report: no addresses, keys, serials or file contents. */
export interface CapabilityReport {
  deviceId: string
  takenAt: string
  device: { model?: string; manufacturer?: string; android?: string; sdk: number; build?: string }
  capabilities: Capability[]
  /** Read-only OS facts for the report (bootloader, Treble, slots, root, DSU). */
  os: Record<string, string>
}

export interface SnapshotSummary {
  id: string
  created: string
  deviceId: string
  label: string
  /** What the snapshot covers (packages, home, theme, dns, ...). */
  coverage: string[]
  packages: number
}

export interface SnapshotDiff {
  a: string
  b: string
  packagesChanged: Array<{ pkg: string; from: string; to: string }>
  homeChanged: { from: string | null; to: string | null } | null
  settingsChanged: Array<{ key: string; from: string; to: string }>
  themeChanged: boolean
}

export interface TvAnalysis {
  takenAt: string
  deviceId: string
  listId: string
  listTitle: string
  adsClutter: { level: 'High' | 'Medium' | 'Low'; enabledBloat: number; totalListed: number }
  performance: { status: 'Good' | 'Needs optimization'; reasons: string[] }
  privacy: { status: 'unscanned'; detail: string }
  storage: { totalKb: number; availKb: number; low: boolean }
  launcher: { home: string | null; isClean: boolean }
  animations: string
  recommendations: string[]
}

export interface FixReport {
  ok: boolean
  summary: string
  warnings: string[]
  snapshotId: string | null
  metrics: {
    packagesDisabled: number
    animationsFrom: string
    animationsTo: string
    storageAvailBeforeKb: number
    storageAvailAfterKb: number
  }
}

export interface CytvApi {
  platform: 'darwin' | 'win32' | 'linux'

  // Connection
  scan(): Promise<ScanHit[]>
  connect(host: string): Promise<ConnStatus>
  disconnect(): Promise<void>
  status(): Promise<ConnStatus>
  lastHost(): Promise<string | null>
  /**
   * Connects to the TV used last time, at the address saved then, and checks the same model answers.
   * If it doesn't, the status has `moved` set and the user picks the TV from a scan. Null when no TV was saved.
   */
  reconnect(): Promise<ConnStatus | null>
  /** Port 5555 refuses or ignores connections (after debugging was switched off). */
  checkAdbClosed(host: string): Promise<{ closed: boolean; message: string }>
  /** Wireless-debugging pairing with Google's adb (downloaded on demand), then opens port 5555. */
  pair(host: string, pairPort: number, code: string, connectPort: number): Promise<ApplyResult>

  // Readiness
  checks(): Promise<CheckItem[]>
  download(tool: ToolId): Promise<ApplyResult>

  // Debloat
  lists(): Promise<DebloatListSummary[]>
  plan(listId: string): Promise<DebloatPlan>
  applyDebloat(req: DebloatApplyRequest): Promise<ApplyResult>
  restore(listId: string): Promise<ApplyResult>

  // Launcher
  launcherStatus(): Promise<LauncherStatus>
  install(req: InstallRequest): Promise<InstallResult>
  buildLocal(): Promise<ApplyResult>
  /** Give Home back to the stock launcher, leaving the new one installed. */
  useStockLauncher(): Promise<ApplyResult>

  // Customise
  apps(): Promise<TvApp[]>
  readTheme(): Promise<TvTheme>
  applyTheme(req: ThemeApplyRequest): Promise<ApplyResult>
  resetTheme(): Promise<ApplyResult>
  presets(): Promise<ThemePreset[]>
  /** PNG of the TV screen as a data URL. */
  screenshot(): Promise<string>
  /** HTTPS GET from Bing or TMDB only (the page itself has no network access). */
  webGet(url: string): Promise<WebResponse>

  // TV extras
  systemState(): Promise<SystemState>
  setClockScreensaver(on: boolean): Promise<ApplyResult>
  setPrivateDns(host: string | null): Promise<ApplyResult>
  setAnimationScale(scale: number): Promise<ApplyResult>
  setLauncherLocale(tag: string): Promise<ApplyResult>
  key(keycode: number): Promise<void>
  reboot(): Promise<void>

  // Devices & capabilities
  listDevices(): Promise<ManagedDevice[]>
  /** The registry entry for the connected TV, if it has been registered. */
  currentDevice(): Promise<ManagedDevice | null>
  removeDevice(id: string): Promise<void>
  deviceCapabilities(): Promise<Capability[]>
  /** Full probed report for the connected TV; safe to share (no addresses or keys). */
  capabilityReport(): Promise<CapabilityReport>

  // Analyze & Fix
  analyzeTv(listId?: string): Promise<TvAnalysis>
  fixTv(listId?: string): Promise<FixReport>

  // Recovery Center (settings + app states, not a firmware backup)
  listSnapshots(deviceId?: string): Promise<SnapshotSummary[]>
  createSnapshot(label: string): Promise<SnapshotSummary>
  restoreSnapshot(id: string): Promise<ApplyResult>
  deleteSnapshot(id: string): Promise<void>
  diffSnapshots(a: string, b: string): Promise<SnapshotDiff>

  // Events
  onLog(cb: (line: LogLine) => void): () => void
  onProgress(cb: (p: DownloadProgress) => void): () => void
  onStatus(cb: (s: ConnStatus) => void): () => void
}

declare global {
  interface Window {
    cytv: CytvApi
  }
}
