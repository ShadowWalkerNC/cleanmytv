// The capability engine: what this TV actually supports, probed instead of assumed by brand.
// Every gate mirrors the check the feature itself makes (same SDK numbers, same tool probes),
// so the UI can hide or explain what the TV cannot do instead of failing at apply time.
import { readFileSync } from 'node:fs'
import { paths } from './paths'
import * as T from './tv'
import { currentDevice } from './devices'
import type { Capability, CapabilityReport } from '@shared/api'

export const CAPS = {
  shell: 'shell',
  settingsRead: 'settings.read',
  settingsWrite: 'settings.write',
  appsList: 'apps.list',
  appsInstall: 'apps.install',
  appsUninstall: 'apps.uninstall',
  appsControl: 'apps.control',
  appsLaunch: 'apps.launch',
  launcherInstall: 'launcher.install',
  launcherSetHome: 'launcher.setHome',
  themePush: 'theme.push',
  themeProvider: 'theme.provider',
  systemScreensaver: 'system.screensaver',
  systemPrivateDns: 'system.privateDns',
  systemAnimations: 'system.animations',
  systemLocale: 'system.locale',
  remoteKeys: 'remote.keys',
  screenshot: 'screenshot',
  powerReboot: 'power.reboot'
} as const

interface Toolset {
  hasCmd: boolean
  hasContent: boolean
  hasPm: boolean
  hasScreencap: boolean
  hasInput: boolean
  hasAppOps: boolean
}

async function toolset(): Promise<Toolset> {
  // One round trip: `command -v` prints the path per tool found, in order.
  const out = await T.tv().shell('for t in cmd content pm screencap input appops; do command -v $t; done')
  const found = new Set(out.split('\n').map((l) => l.trim().split('/').pop()).filter(Boolean))
  return {
    hasCmd: found.has('cmd'),
    hasContent: found.has('content'),
    hasPm: found.has('pm'),
    hasScreencap: found.has('screencap'),
    hasInput: found.has('input'),
    hasAppOps: found.has('appops')
  }
}

function launcherMinSdk(): number | undefined {
  for (const info of [paths.bundledApkInfo, paths.localApk.replace(/\.apk$/, '.json')]) {
    try {
      const minSdk = (JSON.parse(readFileSync(info, 'utf8')) as { minSdk?: number }).minSdk
      if (minSdk) return minSdk
    } catch {
      // next
    }
  }
  return undefined
}

export async function probeCapabilities(): Promise<Capability[]> {
  const probe = T.getStatus().probe
  if (!probe) throw new Error('Connect to a TV first.')
  const sdk = probe.sdk
  const tools = await toolset()
  const minSdk = launcherMinSdk()
  const caps: Capability[] = [
    { id: CAPS.shell, label: 'Shell commands', supported: true },
    { id: CAPS.settingsRead, label: 'Read system settings', supported: true },
    { id: CAPS.settingsWrite, label: 'Change system settings', supported: true },
    { id: CAPS.appsList, label: 'List installed apps', supported: tools.hasPm, detail: tools.hasPm ? undefined : 'No pm on this TV.' },
    { id: CAPS.appsInstall, label: 'Install APKs', supported: tools.hasPm, detail: tools.hasPm ? undefined : 'No pm on this TV.' },
    { id: CAPS.appsUninstall, label: 'Uninstall apps', supported: tools.hasPm, detail: tools.hasPm ? undefined : 'No pm on this TV.' },
    { id: CAPS.appsControl, label: 'Enable / disable / stop / clear apps', supported: tools.hasPm, detail: tools.hasPm ? undefined : 'No pm on this TV.' },
    { id: CAPS.appsLaunch, label: 'Launch apps', supported: tools.hasCmd, detail: tools.hasCmd ? undefined : 'Needs cmd (Android 7+).' },
    {
      id: CAPS.launcherInstall, label: 'Install the clean launcher',
      supported: tools.hasPm && (!minSdk || sdk <= 0 || sdk >= minSdk),
      detail: !tools.hasPm ? 'No pm on this TV.' : minSdk && sdk > 0 && sdk < minSdk ? `This TV runs SDK ${sdk}, the launcher needs ${minSdk}.` : undefined
    },
    { id: CAPS.launcherSetHome, label: 'Hand Home between launchers', supported: tools.hasCmd, detail: tools.hasCmd ? undefined : 'Needs cmd (Android 7+).' },
    { id: CAPS.themePush, label: 'Push themes', supported: true },
    {
      id: CAPS.themeProvider, label: 'ThemeProvider fast path',
      supported: tools.hasContent,
      detail: tools.hasContent ? undefined : 'No content tool; files go through the shell fallback.'
    },
    { id: CAPS.systemScreensaver, label: 'Screensaver choice', supported: true },
    {
      id: CAPS.systemPrivateDns, label: 'Private DNS',
      supported: sdk >= 28, detail: sdk >= 28 ? undefined : `Needs Android 9 (API 28); this TV runs API ${sdk}.`
    },
    { id: CAPS.systemAnimations, label: 'Animation speed', supported: true },
    {
      id: CAPS.systemLocale, label: 'Per-app launcher language',
      supported: sdk >= 33, detail: sdk >= 33 ? undefined : `Needs Android 13 (API 33); this TV runs API ${sdk}.`
    },
    { id: CAPS.remoteKeys, label: 'Remote keys', supported: tools.hasInput, detail: tools.hasInput ? undefined : 'No input tool on this TV.' },
    { id: CAPS.screenshot, label: 'Screenshots', supported: tools.hasScreencap, detail: tools.hasScreencap ? undefined : 'No screencap on this TV.' },
    { id: CAPS.powerReboot, label: 'Restart', supported: true }
  ]
  return caps
}

/** Supported capability ids, for the registry entry. */
export async function supportedIds(): Promise<string[]> {
  return (await probeCapabilities()).filter((c) => c.supported).map((c) => c.id)
}

const OS_PROPS = [
  'ro.build.version.release', 'ro.build.version.sdk', 'ro.build.display.id',
  'ro.build.version.security_patch', 'ro.vendor.build.security_patch',
  'ro.boot.flash.locked', 'ro.boot.verifiedbootstate', 'ro.boot.veritymode',
  'ro.treble.enabled', 'ro.build.ab_update', 'ro.boot.dynamic_partitions',
  'ro.product.first_api_level', 'ro.build.version.codename'
] as const

/** Read-only OS facts for the report. One batched round trip; unknown props stay empty. */
export async function osFacts(): Promise<Record<string, string>> {
  const out = await T.tv().shell(OS_PROPS.map((p) => `getprop ${p}`).join('; '))
  const values = out.replace(/\r/g, '').split('\n')
  const facts: Record<string, string> = {}
  OS_PROPS.forEach((p, i) => { facts[p] = (values[i] ?? '').trim() })
  try {
    const su = (await T.tv().shell('command -v su')).trim()
    facts['shell.su'] = su ? `present (${su})` : 'absent'
  } catch {
    facts['shell.su'] = 'unknown'
  }
  return facts
}

/** Full sanitized report: no addresses, keys, serials or file contents. */
export async function capabilityReport(): Promise<CapabilityReport> {
  const probe = T.getStatus().probe
  if (!probe) throw new Error('Connect to a TV first.')
  const device = currentDevice()
  const [capabilities, os] = await Promise.all([probeCapabilities(), osFacts()])
  return {
    deviceId: device?.id ?? 'unregistered',
    takenAt: new Date().toISOString(),
    device: {
      ...(probe.model ? { model: probe.model } : {}),
      ...(probe.manufacturer ? { manufacturer: probe.manufacturer } : {}),
      ...(probe.release ? { android: probe.release } : {}),
      sdk: probe.sdk,
      ...(probe.build ? { build: probe.build } : {})
    },
    capabilities,
    os
  }
}
