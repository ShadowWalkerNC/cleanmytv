// TV settings outside the launcher, all from upstream README: the Clock screensaver, ad-blocking
// Private DNS, animation speed and the launcher's own language.
import { Socket } from 'node:net'
import * as T from './tv'
import { PKG } from './launcherPkg'
import { runTx } from './tx'
import type { ApplyResult, SystemState } from '@shared/api'

const TASK = 'system'
const CLOCK = `${PKG}/.ClockDream`

async function get(ns: string, key: string): Promise<string> {
  return (await T.tv().shell(`settings get ${ns} ${key}`)).trim()
}

export async function state(): Promise<SystemState> {
  return {
    sdk: T.getStatus().probe?.sdk ?? 0,
    screensaverIsClock: (await get('secure', 'screensaver_components')).includes(CLOCK),
    privateDnsMode: await get('global', 'private_dns_mode'),
    privateDnsHost: await get('global', 'private_dns_specifier'),
    animationScale: await get('global', 'window_animation_scale')
  }
}

async function put(ns: string, key: string, value: string): Promise<void> {
  // 'null' and '' both mean unset: delete the key instead of writing the word.
  await T.sh(TASK, value === 'null' || value === '' ? `settings delete ${ns} ${key}` : `settings put ${ns} ${key} ${value}`)
}

function txResult(title: string, tx: { ok: boolean; error?: string; rolledBack: string[]; rollbackError?: string }, summary: string, warnings: string[] = []): ApplyResult {
  if (tx.ok) return { ok: true, summary, warnings }
  return {
    ok: false,
    summary: `${title} failed (${tx.error})${tx.rolledBack.length ? ' and was rolled back' : ''}.`,
    warnings: [...warnings, ...(tx.rollbackError ? [tx.rollbackError] : [])]
  }
}

export async function clockScreensaver(on: boolean): Promise<ApplyResult> {
  const tx = await runTx(TASK, 'Screensaver', [{
    label: on ? 'use the Clock screensaver' : 'use the TV screensaver',
    plan: on ? [`screensaver_components = ${CLOCK}`, 'screensaver_enabled = 1'] : ['delete screensaver_components (the TV default dream returns)'],
    snapshot: async () => ({ components: await get('secure', 'screensaver_components'), enabled: await get('secure', 'screensaver_enabled') }),
    apply: async () => {
      if (on) await T.sh(TASK, `settings put secure screensaver_components ${CLOCK}; settings put secure screensaver_enabled 1`)
      // Back to the TV's own choice: an empty value makes Android use its default dream.
      else await T.sh(TASK, 'settings delete secure screensaver_components')
    },
    verify: async () => {
      const now = await get('secure', 'screensaver_components')
      if (on && !now.includes(CLOCK)) throw new Error('the TV still reports another screensaver')
      if (!on && now.includes(CLOCK)) throw new Error('the TV still reports the Clock screensaver')
    },
    rollback: async (prior) => {
      await put('secure', 'screensaver_components', prior.components)
      await put('secure', 'screensaver_enabled', prior.enabled)
    }
  }])
  return txResult('Screensaver', tx, on ? 'The Clock screensaver is on.' : "The TV's own screensaver is back.")
}

export async function privateDns(host: string | null): Promise<ApplyResult> {
  if (host) {
    T.q(host)
    if (!/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(host)) throw new Error(`not a DNS host name: ${host}`)
    if ((T.getStatus().probe?.sdk ?? 0) < 28) throw new Error('Private DNS needs Android 9 or newer.')
  }
  const warn = ['If an app stops playing or the TV says "No internet", switch Private DNS off here.']
  const tx = await runTx(TASK, 'Private DNS', [{
    label: host ? `use ${host}` : 'back to automatic',
    plan: host ? [`private_dns_specifier = ${host}`, 'private_dns_mode = hostname'] : ['private_dns_mode = opportunistic'],
    snapshot: async () => ({ mode: await get('global', 'private_dns_mode'), spec: await get('global', 'private_dns_specifier') }),
    apply: async () => {
      if (host) {
        await T.sh(TASK, `settings put global private_dns_specifier ${host}`)
        await T.sh(TASK, 'settings put global private_dns_mode hostname')
      } else {
        await T.sh(TASK, 'settings put global private_dns_mode opportunistic')
      }
    },
    verify: async () => {
      const mode = await get('global', 'private_dns_mode')
      const spec = await get('global', 'private_dns_specifier')
      if (host && (mode !== 'hostname' || spec !== host)) throw new Error(`the TV reports ${mode} ${spec}`)
      if (!host && mode !== 'opportunistic') throw new Error(`the TV still reports ${mode}`)
    },
    rollback: async (prior) => {
      if (prior.mode === 'hostname' && prior.spec && prior.spec !== 'null') {
        await T.sh(TASK, `settings put global private_dns_specifier ${prior.spec}`)
        await T.sh(TASK, 'settings put global private_dns_mode hostname')
      } else if (['off', 'opportunistic'].includes(prior.mode)) {
        await T.sh(TASK, `settings put global private_dns_mode ${prior.mode}`)
      } else {
        await T.sh(TASK, 'settings put global private_dns_mode opportunistic')
      }
    }
  }])
  return txResult('Private DNS', tx, host ? `Every app's DNS now goes to ${host}.` : 'Private DNS is back to automatic.', host ? warn : [])
}

const ANIM_KEYS = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']

export async function animationScale(scale: number): Promise<ApplyResult> {
  if (![0, 0.5, 1].includes(scale)) throw new Error('scale must be 0, 0.5 or 1')
  const tx = await runTx(TASK, 'Animation speed', [{
    label: `animations at ${scale}x`,
    plan: ANIM_KEYS.map((k) => `${k} = ${scale}`),
    snapshot: async () => {
      const prior: Record<string, string> = {}
      for (const k of ANIM_KEYS) prior[k] = await get('global', k)
      return prior
    },
    apply: async () => {
      for (const k of ANIM_KEYS) await T.sh(TASK, `settings put global ${k} ${scale}`)
    },
    verify: async () => {
      for (const k of ANIM_KEYS) {
        const now = await get('global', k)
        if (now !== String(scale)) throw new Error(`${k} still reports ${now}`)
      }
    },
    rollback: async (prior) => {
      for (const k of ANIM_KEYS) await put('global', k, prior[k])
    }
  }])
  return txResult('Animation speed', tx, scale === 0 ? 'System animations are off.' : `System animations run at ${scale}x.`)
}

export async function launcherLocale(tag: string): Promise<ApplyResult> {
  if (tag && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag)) throw new Error(`not a language tag: ${tag}`)
  if ((T.getStatus().probe?.sdk ?? 0) < 33) throw new Error('A per-app language needs Android 13 or newer; the launcher follows the TV language.')
  const restart = async (): Promise<void> => {
    await T.sh(TASK, `am force-stop ${PKG}; am start -n ${PKG}/.MainActivity >/dev/null`)
  }
  const tx = await runTx(TASK, 'Launcher language', [{
    label: tag ? `launcher in ${tag}` : 'launcher follows the TV',
    plan: [`app locales for ${PKG} = ${tag || '(TV language)'}`],
    snapshot: async () => {
      // The answer is a bracketed list ("[en-US]"); only the locales go back on rollback.
      const raw = (await T.tv().shell(`cmd locale get-app-locales ${PKG}`)).trim()
      return /\[([^\]]*)\]/.exec(raw)?.[1] ?? ''
    },
    apply: async () => {
      await T.sh(TASK, `cmd locale set-app-locales ${PKG} --locales ${tag || '""'}`)
      await restart()
    },
    verify: async () => {
      const now = (await T.tv().shell(`cmd locale get-app-locales ${PKG}`)).trim()
      if (tag) {
        if (!new RegExp(`\\b${tag}\\b`).test(now)) throw new Error(`the TV reports ${now || '(empty)'}`)
      } else if (/\[[^\]]*[A-Za-z]/.test(now)) {
        throw new Error(`the TV still reports ${now}`)
      }
    },
    rollback: async (prior) => {
      await T.sh(TASK, `cmd locale set-app-locales ${PKG} --locales ${prior ? T.q(prior) : '""'}`)
      await restart()
    }
  }])
  return txResult('Launcher language', tx, tag ? `The launcher now shows ${tag}.` : 'The launcher follows the TV language again.')
}

export async function key(code: number): Promise<void> {
  if (!Number.isInteger(code) || code < 0 || code > 400) throw new Error('bad keycode')
  await T.tv().shell(`input keyevent ${code}`)
}

export async function reboot(): Promise<void> {
  await T.tv().shell('reboot').catch(() => undefined)
}

/** Upstream tools/adb-closed.py: refused or silent means closed. */
export function adbClosed(host: string): Promise<{ closed: boolean; message: string }> {
  return new Promise((resolve) => {
    const s = new Socket()
    const done = (closed: boolean, message: string): void => { s.destroy(); resolve({ closed, message }) }
    s.setTimeout(3000)
    s.once('connect', () => done(false, `${host}:5555 is still open: network debugging is on. On the TV, switch USB debugging and Network/ADB debugging off, reboot, and check again.`))
    s.once('timeout', () => done(true, `${host}:5555 did not answer in 3 s: closed, unless the TV is off or at another address.`))
    s.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ECONNREFUSED') done(true, `${host}:5555 is closed: the TV refused the connection.`)
      else done(false, `Could not check ${host}:5555 (${e.code ?? e.message}). Is the TV on and on this network?`)
    })
    s.connect(5555, host)
  })
}
