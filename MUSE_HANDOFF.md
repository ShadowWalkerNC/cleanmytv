# CleanMyTV — Muse Code Handoff

## Mission

Build on the existing open-source CleanMyTV desktop companion and CleanYourTV v3 ecosystem to create a local-first desktop management console for this TV setup:

- onn. 4K Android/Google TV box = smart compute layer
- VIZIO V435-H1 = display/audio/HDMI/picture layer
- CleanMyTV desktop app = management, optimization, orchestration, recovery

Do not rewrite the project from scratch.

Do not replace Electron/React/TypeScript with Tauri/Rust yet.

Do not try to combine the processors of the onn. box and Vizio. Coordinate them as one logical TV Stack.

---

## Repositories

### CleanYourTV
Upstream:
`Gathin23/cleanyourtv`

Purpose:
- lightweight Android TV launcher
- TV-specific debloat lists
- themes
- switches
- add-ons
- device compatibility
- recovery tooling

Current major line:
`v3.x`

Keep the launcher lightweight.

### CleanMyTV
Upstream:
`wingedpanther/cleanmytv`

Personal fork:
`ShadowWalkerNC/cleanmytv`

Existing stack:
- Electron
- React
- TypeScript
- electron-vite
- Vitest
- custom ADB-over-TCP
- Wireless Debugging pairing
- reversible debloat
- launcher install/rollback
- themes/layout
- screenshots
- remote controls
- Private DNS
- animation settings
- reboot
- fake-TV test environment

The repository itself is authoritative if details have changed.

---

## Git Rules

Use:

- `main` = clean upstream-aligned baseline
- `personal` = full personal build
- `feat/*` = one reusable upstreamable feature
- `fix/*` = one fix
- `chore/*` = maintenance/compatibility
- `exp/*` = experiments

Configure:
- `origin` → `ShadowWalkerNC/cleanmytv`
- `upstream` → `wingedpanther/cleanmytv`

Do not open PRs directly from `personal`.
Keep upstream PRs focused on one topic.

---

## Known Hardware

### VIZIO V435-H1
Platform:
- VIZIO SmartCast / VIZIO OS
- Firmware observed: `1.720.9.1-1`
- Software observed: `1.720.9.1-1.21`

Treat it as:
- panel
- audio
- HDMI
- picture processing
- power/volume/input control

Do NOT:
- use ADB against it
- install APKs on it
- expose Android package management
- expose Android launcher controls
- attempt jailbreak/root as part of normal development

Do not commit:
- serial number
- Wi-Fi SSID
- local IP
- pairing token
- auth token

### onn. Android/Google TV box
Primary smart-compute target.

Expected capabilities:
- Wireless ADB
- APK sideloading
- launcher replacement
- package management
- app launching
- screenshots
- settings control
- Private DNS
- kiosk/display workloads
- remote control
- custom apps

Do not assume exact model/revision until probed.

Probe:
- manufacturer
- model
- device
- product
- Android release
- SDK/API
- build ID
- build fingerprint
- CPU ABI
- RAM
- storage
- current Home
- installed packages
- enabled/disabled packages

Match against existing CleanYourTV onn. profiles before creating a new profile.

---

## Android TV Platform

Modern Android TV target:
**Android 16 for TV**

Do not require Android 16.
Do not force OS upgrades.
Capability-detect at runtime.

Future-useful Android 16-era capabilities may include:
- MediaQualityManager
- HDMI-CEC improvements
- modern media features
- newer audio support
- 64-bit improvements

These are optional capabilities, not dependencies.

---

## Autonomy Policy

### AUTO
Perform without asking when safe:
- inspect repo
- install dependencies
- build
- typecheck
- test
- modify code
- create branches
- local commits
- fake-device testing
- network/device discovery
- read-only probes
- screenshots
- logs
- package enumeration
- RAM/storage inspection
- launcher inspection
- known-safe reversible optimization
- reversible package disable/enable
- launcher/theme config
- animation adjustment
- cache cleanup
- app launching
- validation
- rollback after regressions

### AUTO WITH RECOVERY
Allowed automatically after state capture:
- debloat profile
- launcher replacement
- Fast / Light profile
- Private DNS
- bulk package changes
- system preferences
- app updates

Pattern:
`inspect → snapshot → apply → verify → keep or rollback`

### HUMAN PHYSICAL STEP
Ask only when physically required:
- Wireless Debugging pairing code
- Android Allow debugging prompt
- Vizio pairing PIN
- unavoidable manual remote action
- physical power cycle if software cannot do it

After the user completes the step, continue automatically.

### DO NOT AUTO
Never perform without separate explicit approval:
- bootloader unlock
- root
- custom recovery
- custom ROM
- firmware flash
- partition modification
- factory reset
- hardware exploit attempts
- destructive system-package deletion
- credible brick-risk operations

---

## Existing Architecture to Preserve

Important areas:

- `src/shared/api.ts`
- `src/preload/`
- `src/main/index.ts`
- `src/main/tv.ts`
- `src/main/adb/`
- `src/main/scan.ts`
- `src/main/reconnect.ts`
- `src/main/debloat.ts`
- `src/main/launcher.ts`
- `src/main/theme.ts`
- `src/main/system.ts`
- `src/main/toolchain.ts`
- `src/renderer/`
- `tests/`

Preserve:
- typed renderer ↔ preload ↔ main-process API
- renderer isolation
- sandbox
- context isolation
- no Node integration in renderer

Do not add an arbitrary shell box to normal UI.

---

## Full Execution Order

### Phase 0 — Baseline
Run:

```powershell
npm ci
npm run sync
npm run typecheck
npm test
npm run dev
```

Also run fake TV:

```powershell
npx tsx scripts/fake-tv.ts
```

Fix ordinary baseline issues instead of stopping to report them.

### Phase 1 — CleanYourTV v3 Compatibility
Create:

`chore/upstream-v3`

Inspect current `upstream.json`.
Compare pinned upstream with current CleanYourTV v3 line.

Review:
- launcher config
- themes
- switches
- safety changes
- device profiles
- tools
- add-ons

Make only compatibility changes.
Run all tests and build again.

Do not stop here.

### Phase 2 — Connect Real onn.
Use Wireless Debugging.
Ask only for pairing code / Allow prompt if required.

Then continue automatically.

### Phase 3 — Probe Hardware
Collect exact device/runtime info.
Save a sanitized local report.
Do not put private network data into Git.

### Phase 4 — BEFORE Baseline
Collect:
- Home launcher
- RAM snapshot
- free storage
- enabled/disabled package counts
- animation scale
- Private DNS
- screensaver state
- launcher screenshot
- other useful screenshots

### Phase 5 — Recovery Snapshot
Before modifying:
- record package states for touched packages
- current Home
- launcher state
- theme/config
- animation settings
- Private DNS
- screensaver

Do not claim full firmware backup.

### Phase 6 — Match Safe Debloat Profile
Priority:
1. exact model + build
2. exact model
3. device family
4. generic evidence

Never apply another TV's aggressive list blindly.

### Phase 7 — Classify Packages
Use:
- PROTECTED
- KEEP
- RECOMMENDED DISABLE
- SAFE OPTIONAL
- BREAKS FEATURE
- UNKNOWN

Protected by default:
- Android framework
- SystemUI
- Settings
- Permission Controller
- Package Installer
- shell
- required content providers
- usable Home until replacement verified
- remote/input services
- HDMI/input services

Unknown is not automatically disabled.

### Phase 8 — Declutter Actual onn.
Use reversible `pm disable-user` where appropriate.

Disable only verified:
- recommendation components
- telemetry
- unused OEM packages
- unused gaming/promotional components
- verified optional background services

Preserve by default:
- Wi-Fi
- Bluetooth remote
- HDMI
- audio
- Play Store
- casting
- phone remote
- voice
- updates

### Phase 9 — Install/Verify CleanYourTV Launcher
Install compatible launcher.
Perform safe Home handoff.

If handoff fails:
- rollback to stock Home
- identify cause
- fix
- retry only when safe

Never leave device without a usable launcher.

### Phase 10 — Fast / Light Profile
Apply:

- CleanYourTV launcher ON
- animation scale 0.5x
- reduced motion ON
- rotating wallpaper OFF
- heavy visual effects OFF
- unnecessary widgets OFF
- minimal Home layout
- verified bloat disabled
- optional Private DNS
- simple screensaver

Do NOT use random internet tweaks such as:
- Don't keep activities
- background process limit = 0
- Force GPU rendering
- Disable HW overlays

### Phase 11 — Storage Cleanup
Safely clean:
- disposable caches
- old installer APKs
- temporary tool artifacts
- unused user apps where appropriate

Do not wipe app data indiscriminately.
Do not log users out unnecessarily.

### Phase 12 — Reboot + Validate
Reboot.
Wait until Home is actually ready.
Reconnect.

Verify:
- boot
- Home
- D-pad
- OK/Back/Home
- volume
- Wi-Fi
- audio
- video
- HDMI
- Settings
- Play Store if retained
- selected streaming apps
- screenshots
- reconnect
- package state after reboot
- Private DNS if configured
- screensaver
- casting if preserved
- voice if preserved
- phone remote if preserved
- Bluetooth remote
- CEC where available

If a feature breaks:
1. identify likely package/setting
2. restore it
3. retest
4. update safe profile
5. continue

### Phase 13 — AFTER Baseline
Collect same measurements as BEFORE.

Compare:
- Home
- RAM snapshot
- free storage
- package state
- animation state
- screenshots
- functional results

Do not invent performance percentages.

---

## Completion Criteria for Real TV Cleanup

Do not consider the task complete until:

- device boots reliably
- CleanYourTV launcher works
- cleanup survives reboot
- important features work
- restore path exists
- no unknown critical package was removed
- Fast / Light profile is active
- before/after evidence exists

---

## App Manager

After the physical baseline is healthy, create:

`feat/app-manager`

Suggested files:
- `src/main/apps.ts`
- `src/renderer/src/screens/Apps.tsx`

Typed operations:
- `listApps()`
- `installApk()`
- `uninstallUserApp()`
- `enablePackage()`
- `disablePackage()`
- `launchApp()`
- `forceStopApp()`
- `clearAppCache()`
- `appInfo()`

UI should show:
- app name
- package
- version
- system/user
- TV/phone-style
- enabled state
- running state where practical

Actions:
- Launch
- Stop
- Enable
- Disable
- Uninstall user app
- Install/update APK
- Clear cache

Protected packages should not receive dangerous actions.

---

## APK Sideloading

Support:
- file picker
- drag-and-drop
- package metadata
- version comparison
- install/update
- launch after install

Do not advertise APKS/APKM/XAPK until properly implemented.

---

## Device Capability Layer

Add gradual capability abstraction.

Example:

```ts
interface DeviceCapabilities {
  apps: {
    list: boolean
    install: boolean
    uninstall: boolean
    enableDisable: boolean
    launch: boolean
  }
  launcher: {
    replace: boolean
    configure: boolean
    wallpaper: boolean
  }
  system: {
    screenshot: boolean
    reboot: boolean
    remote: boolean
    privateDns: boolean
  }
  display: {
    power: boolean
    volume: boolean
    mute: boolean
    input: boolean
  }
}
```

UI should depend on capabilities, not brand checks.

---

## Android TV Technologies to Leverage

Use where useful:

### Wireless ADB
Administration:
- install
- package control
- diagnostics
- screenshots
- logs
- settings

### Android TV Remote Protocol v2
Everyday control:
- D-pad
- OK
- Back
- Home
- keyboard
- volume
- media
- app/deep-link actions
- state

Goal:
ADB for administration, Remote v2 for normal daily control.

### mDNS
Automatic device discovery.
Do not rely only on static IPs.

### scrcpy
Optional advanced live view / debugging.
Do not make it mandatory.

### Private DNS
Optional privacy/ad-reduction layer.

### HDMI-CEC
Use for:
- wake
- power
- input
- playback coordination

Do not rely on it exclusively.

### Compose for TV
Use for future native TV apps:
- CulinaryOS TV
- Cheezies display
- menu boards
- dashboards
- kiosk apps

Design for:
- 10-foot viewing
- D-pad
- focus states
- large typography
- few actions

### Media3 / ExoPlayer
Use for:
- signage
- promo loops
- training video
- menu media

Prefer hardware decoding.

---

## Ad / Privacy Strategy

### Android / onn.

Layered approach:
1. lightweight CleanYourTV launcher
2. reversible debloat
3. Private DNS
4. optional Pi-hole / AdGuard Home
5. app-specific controls

Never claim universal ad blocking.

Potential privacy controls:
- usage/diagnostics
- recommendation services
- telemetry packages
- Private DNS
- permissions

Always explain feature tradeoffs.

### Vizio

Do not Android-debloat it.

Preferred setup:
`Vizio = display`
`onn. = smart interface`

Normal flow:
`Vizio power → onn. HDMI → CleanYourTV`

Later:
- disable Viewing Data / ACR
- test local DNS filtering carefully
- avoid breaking SmartCast functionality
- provide rollback

---

## Vizio Provider — Later

After Android side is stable.

Suggested provider structure:

- `src/main/providers/types.ts`
- `src/main/providers/android.ts`
- `src/main/providers/vizio.ts`

Vizio capabilities:
- discover
- pair
- connect
- status
- power
- volume
- mute
- navigation
- inputs
- input switching
- device info
- safe settings where supported

Do not expose:
- APK install
- ADB
- Android package management
- Android launcher
- Android debloat

Pairing tokens must be stored locally and securely.
Never log or commit them.

---

## TV Stack

Logical group:

```text
Living Room TV Stack
├── Display: VIZIO V435-H1
└── Smart Device: onn.
```

Composite command examples:

### Watch Plex
- power Vizio
- switch Vizio to onn. HDMI
- wake onn.
- launch Plex

### Movie
- Vizio on
- correct HDMI
- picture mode if supported
- onn. wake
- launch media app

### CulinaryOS
- TV on
- correct HDMI
- onn. wake
- launch CulinaryOS
- screensaver off
- Kitchen profile

---

## Profiles

Declarative only.
No arbitrary shell scripts.

Examples:
- Normal
- Fast / Light
- Movie
- Streaming
- Kitchen Display
- CulinaryOS
- Cheezies Display
- Developer
- Kiosk
- Night

Example:

```yaml
name: Kitchen Display

display:
  power: on
  input: onn

android:
  launch: culinaryos
  animations: 0.5
  screensaver: off

privacy:
  private_dns: enabled
```

---

## Performance Screen — Later

Useful metrics only:
- RAM
- storage
- Home launcher
- running apps/processes
- animation state
- uptime
- temperature only if reliably exposed

Add an `Optimize TV` action:

`analyze → snapshot → apply → reboot if needed → validate → rollback regressions`

Never use random tuning commands.

---

## CLI — Later

Reuse same service layer.

Examples:
- `cleanmytv devices`
- `cleanmytv status`
- `cleanmytv launch onn plex`
- `cleanmytv install onn app.apk`
- `cleanmytv optimize onn`
- `cleanmytv profile living-room movie`

No duplicate backend logic.

---

## MCP — Later

Expose safe typed tools for AI agents:

- `list_devices`
- `device_status`
- `launch_app`
- `install_apk`
- `apply_profile`
- `optimize_device`
- `take_screenshot`
- `send_remote_key`
- `switch_input`

Do NOT expose unrestricted arbitrary shell execution by default.

---

## Root / Jailbreak Policy

Do not make root part of the normal product.

After exact onn. hardware is known, research:
- bootloader unlock
- custom recovery
- LineageOS/custom ROM
- root
- stock image availability
- brick recovery path

Produce risk/benefit assessment first.

Do not execute automatically.

Do not jailbreak Vizio as a routine step.

---

## Sensitive Data

Never commit:
- ADB private keys
- Wi-Fi password
- SSID
- serial number
- auth tokens
- pairing codes
- API keys
- private IPs as permanent config

Redact secrets from logs.

---

## Testing

Every device-changing feature should have:
- unit test
- fake-device test where possible
- integration test
- real-device smoke test
- rollback verification

CI must not depend on physical TV hardware.

---

## Failure Handling

If code/test issue:
- fix automatically

If connection issue:
- retry intelligently

If device IP changed:
- rediscover

If package breaks feature:
- restore package
- retest

If launcher handoff fails:
- rollback Home

If pairing required:
- ask only for pairing code

If operation involves root/flash/brick risk:
- stop and ask for explicit approval

Do not abandon the whole task because one optional feature is unavailable.

---

## Final Product Vision

CleanMyTV should become:

A local-first, open-source TV management and orchestration console that safely manages Android/Google TV devices, coordinates compatible smart displays, optimizes low-power hardware, provides recovery for meaningful changes, and exposes the same controlled core to desktop UI, CLI, automation and AI agents.

For this setup:

- Vizio = panel
- onn. = smart-TV computer
- CleanMyTV = operating console

Do not chase jailbreaks before exhausting safe capabilities through:
- Wireless ADB
- CleanYourTV
- Android TV Remote v2
- mDNS
- scrcpy
- Private DNS
- HDMI-CEC
- SmartCast
- Compose for TV
- Media3

---

## Immediate Muse Directive

Do not stop at planning.

Execute in this order:

1. inspect repo
2. establish build/test baseline
3. fix baseline defects
4. update/verify CleanYourTV v3 compatibility
5. build application
6. connect physical onn. via Wireless Debugging
7. request pairing code only if needed
8. probe exact hardware
9. identify exact profile
10. collect BEFORE baseline
11. create recovery snapshot
12. perform safe declutter
13. install/verify lightweight launcher
14. apply Fast / Light profile
15. clean safe storage/caches
16. reboot
17. reconnect
18. validate remote/Wi-Fi/audio/video/HDMI/settings/apps
19. restore anything that broke
20. collect AFTER baseline
21. leave device in a verified working state
22. proceed to App Manager development once physical baseline is healthy

Do not intentionally stop after compatibility work.

Only stop for:
- required physical pairing action
- factory reset
- bootloader unlock
- root
- firmware flash
- custom ROM
- partition modification
- credible brick risk

Otherwise:

**Proceed. Test. Verify. Repair. Continue.**
