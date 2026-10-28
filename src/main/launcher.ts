// Install the launcher and hand Home over to it: the port of upstream launcher/build-and-install.sh,
// minus the build (the APK comes bundled, or from the optional local build in toolchain.ts).
import { existsSync, readFileSync } from 'node:fs'
import { paths } from './paths'
import { log } from './log'
import * as T from './tv'
import { runTx } from './tx'
import { autoSnapshot } from './recovery'
import { HOME_RE, KNOWN_STOCK_LAUNCHERS } from './debloat'
import { PKG } from './launcherPkg'
import type { ApplyResult, InstallRequest, InstallResult, LauncherStatus } from '@shared/api'

export { PKG }

const TASK = 'install'
const MAIN = `${PKG}/.MainActivity`

function apkInfo(infoPath: string): { versionName?: string; minSdk?: number } {
  try {
    return JSON.parse(readFileSync(infoPath, 'utf8'))
  } catch {
    return {}
  }
}

export async function status(): Promise<LauncherStatus> {
  const dump = await T.tv().shell(`dumpsys package ${PKG} | grep -m1 versionName`)
  const version = /versionName=(\S+)/.exec(dump)?.[1]
  const home = await T.homeComponent()
  const { installed } = await T.packageSets()
  return {
    installed: installed.has(PKG),
    versionName: version,
    isHome: !!home && home.startsWith(PKG + '/'),
    homeComponent: home,
    stockLauncher: KNOWN_STOCK_LAUNCHERS.find((p) => installed.has(p)) ?? null,
    bundledApk: existsSync(paths.bundledApk),
    bundledVersion: apkInfo(paths.bundledApkInfo).versionName,
    localApk: existsSync(paths.localApk)
  }
}

/** Which app owns Home differs by build, so ask the TV, and accept only a launcher we recognise. */
async function detectStock(): Promise<string> {
  const answer = await T.homeAnswer()
  const homePkg = answer.split('/')[0]
  if (KNOWN_STOCK_LAUNCHERS.includes(homePkg)) return homePkg
  if (homePkg === PKG) {
    log(TASK, 'info', 'Home already belongs to this launcher; nothing will be disabled.')
    return 'none'
  }
  if (homePkg === 'android') {
    // Android's chooser: two launchers tie and no default is set. Take the one known stock launcher
    // among the HOME claimants, if there is exactly one.
    const claims = await T.homeClaimants()
    const found = KNOWN_STOCK_LAUNCHERS.filter((k) => claims.includes(k))
    if (found.length === 1) {
      log(TASK, 'info', `Home is Android's chooser; the stock launcher among the candidates is ${found[0]}.`)
      return found[0]
    }
    throw new Error(`Home is Android's launcher chooser and ${found.length} known stock launchers claim it. Pick a default on the TV first, or choose "Leave the stock launcher alone".`)
  }
  if (homePkg === 'com.google.android.tungsten.setupwraith') {
    throw new Error("Home resolves to Google TV's setup wizard. Add com.google.android.tungsten.setupwraith to your cleanup list, apply it, then install again.")
  }
  throw new Error(`Home resolves to '${homePkg || 'nothing'}', which is not a stock launcher this app knows. Choose "Leave the stock launcher alone" to install without disabling anything.`)
}

async function rollback(stock: string): Promise<boolean> {
  if (stock === 'none') return false
  try {
    await T.sh(TASK, `pm enable --user 0 ${stock}`)
    await T.sh(TASK, `cmd package set-home-activity --user 0 $(${T.HOME_QUERY} ${stock} | tail -n 1)`)
    const back = await T.homeComponent()
    if (back?.startsWith(stock + '/')) {
      log(TASK, 'ok', `${stock} owns Home again.`)
      return true
    }
  } catch (e) {
    log(TASK, 'error', `rollback failed: ${(e as Error).message}`)
  }
  return false
}

export async function install(req: InstallRequest): Promise<InstallResult> {
  const apkPath = req.apk === 'local' ? paths.localApk : paths.bundledApk
  if (!existsSync(apkPath)) {
    return { ok: false, summary: req.apk === 'local' ? 'No local build yet. Build from source first.' : 'The bundled launcher is missing from this copy of the app.', warnings: [] }
  }
  const warnings: string[] = []
  // Below minSdk, `pm install` refuses the APK with INSTALL_FAILED_OLDER_SDK. Refuse it before the
  // TV is asked anything, from the number recorded when the APK was built (upstream #576).
  const minSdk = apkInfo(apkPath.replace(/\.apk$/, '.json')).minSdk
  const tvSdk = T.getStatus().probe?.sdk ?? 0
  if (minSdk && tvSdk > 0 && tvSdk < minSdk) {
    return {
      ok: false,
      summary: `This TV runs SDK ${tvSdk} and the launcher needs SDK ${minSdk}, so Android would refuse it. Nothing was installed or switched off.`,
      warnings: ['The cleanup half of the app still applies to that set, from its own home screen.']
    }
  }
  let stock = req.stockLauncher
  if (stock === 'auto') stock = await detectStock()
  else if (stock !== 'none' && !T.PACKAGE_RE.test(stock)) throw new Error(`not a package name: ${stock}`)
  log(TASK, 'info', `stock launcher: ${stock}`)

  // Automatic recovery point before anything changes (best-effort: the handover transaction
  // below rolls back on its own). Deferred use only: recovery.ts also imports this module.
  try {
    await autoSnapshot('launcher')
  } catch (e) {
    warnings.push(`Automatic recovery point failed (${(e as Error).message}); install continues with transaction rollback only.`)
  }

  const tmp = '/data/local/tmp/tvhome.apk'
  await T.pushB64(TASK, readFileSync(apkPath), tmp)

  // Install on its own: in a batch a failed install would not stop the stock launcher being disabled.
  let out = await T.sh(TASK, `pm install -r ${tmp}`, { timeoutMs: 300000 })
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(out)) {
    if (!req.replaceIncompatible) {
      await T.sh(TASK, `rm -f ${tmp}`)
      return {
        ok: false,
        incompatible: true,
        summary: 'The launcher on the TV was built on another computer and signed with a different key.',
        warnings: ['Replacing it uninstalls the old copy first. Tile order and app library choices made on the TV are lost; settings pushed from this app are kept.']
      }
    }
    // Home must not point at a package that is about to vanish: give it to the stock launcher first.
    const s = stock === 'none' ? (await status()).stockLauncher : stock
    if (s) {
      await rollback(s)
      stock = s   // it was disabled before; the handover below disables it again
    }
    await T.sh(TASK, `pm uninstall ${PKG}`)
    out = await T.sh(TASK, `pm install -r ${tmp}`, { timeoutMs: 300000 })
  }
  await T.sh(TASK, `rm -f ${tmp}`)
  if (out.includes('INSTALL_FAILED_OLDER_SDK')) {
    // The pre-flight above missed it (a TV whose probe did not answer, or an APK built elsewhere):
    // name the real cause instead of leaving the raw Failure line to be read as an ADB problem.
    return {
      ok: false,
      summary: `Android refused the APK as too new for this set (INSTALL_FAILED_OLDER_SDK): the TV runs an older SDK than the launcher's minimum${minSdk ? ` of ${minSdk}` : ''}. The stock launcher was left untouched.`,
      warnings: []
    }
  }
  if (!out.includes('Success')) {
    return { ok: false, summary: 'Install failed; the stock launcher was left alone.', warnings: [out.trim()] }
  }

  // Replacing the launcher while it is Home lets Android restart it mid-update, and on a TCL G03
  // that instance came up broken: Home then left the previous app on screen (#1101). `am start`
  // below would only reuse it, so stop it first; the start then creates a fresh one. A force stop
  // also takes the key helpers off the enabled list, so a helper that was on is written back
  // (cleared first: Android binds again only when the list changes).
  await T.sh(TASK, `s=$(settings get secure enabled_accessibility_services); a=$(settings get secure accessibility_enabled); am force-stop ${PKG}; case "$s" in *${PKG}*) settings put secure enabled_accessibility_services ""; settings put secure enabled_accessibility_services "$s"; settings put secure accessibility_enabled "$a" ;; esac`)

  // Start the launcher before the stock Home is touched: "Status: ok" proves the activity came up.
  // With the stock launcher left alone the component alone still proves it: a MAIN+HOME start would
  // make this launcher the home process until a restart, and Android then blocks the stock
  // launcher's remote-button launches (upstream #1274).
  const startCmd = stock === 'none'
    ? `am start -W -n ${MAIN}`
    : `am start -W -a android.intent.action.MAIN -c android.intent.category.HOME -n ${MAIN}`
  const start = await T.sh(TASK, startCmd)
  if (!start.includes('Status: ok') || /^Error/im.test(start)) {
    return { ok: false, summary: `The new launcher did not start; ${stock === 'none' ? 'nothing was disabled' : stock + ' was left enabled'}.`, warnings: [start.trim()] }
  }
  // Android drops the home preference whenever the set of HOME apps changes, and on Google TV the next
  // candidate can be the setup wizard, which crash-loops. The handover is one transaction: disable
  // the stock launcher and move Home, verify Home landed on the new launcher, else put the stock
  // launcher back and remove the new one when this run installed it.
  let now: string | null = null
  const tx = await runTx(TASK, 'Hand over Home', [{
    label: stock === 'none' ? 'move Home to the new launcher' : `disable ${stock} and move Home`,
    plan: stock === 'none'
      ? ['stock launcher left alone', `Home -> ${MAIN}`]
      : [`pm disable-user --user 0 ${stock}`, `Home -> ${MAIN}`],
    snapshot: async () => ({ home: await T.homeComponent().catch(() => null), installed: (await T.packageSets()).installed.has(PKG) }),
    apply: async () => {
      await T.batch(TASK, [
        `pm grant ${PKG} android.permission.ACCESS_FINE_LOCATION 2>/dev/null; echo location-granted`,
        `cmd package compile -m speed -f ${PKG}`,
        stock === 'none' ? 'echo stock launcher left alone' : `pm disable-user --user 0 ${stock}`,
        `cmd package set-home-activity --user 0 ${MAIN}`
      ])
    },
    verify: async () => {
      try { now = await T.homeComponent() } catch { now = null }
      if (!now?.startsWith(PKG + '/')) throw new Error(now ? `Home resolves to ${now}` : 'the TV stopped answering')
    },
    rollback: async (snap) => {
      // Nothing was disabled with stock 'none': Home goes back to what it was, and the new
      // launcher comes off again when this run installed it.
      if (stock === 'none') {
        if (snap.home && HOME_RE.test(snap.home)) await T.sh(TASK, `cmd package set-home-activity --user 0 ${snap.home}`)
        if (!snap.installed) await T.sh(TASK, `pm uninstall ${PKG}`)
        return
      }
      const back = await rollback(stock)
      if (!back) throw new Error(`could not give Home back automatically (run: pm enable --user 0 ${stock})`)
      if (!snap.installed) await T.sh(TASK, `pm uninstall ${PKG}`)
    }
  }])
  if (!tx.ok) {
    return {
      ok: false,
      summary: `Installed, but ${tx.error}.`,
      warnings: [
        ...(tx.rolledBack.length ? [`${stock} was put back as Home.`] : []),
        ...(tx.rollbackError ? [tx.rollbackError] : []),
        'On Google TV this usually means com.google.android.tungsten.setupwraith also claims Home: add it to your cleanup list, apply it, then install again.'
      ]
    }
  }
  log(TASK, 'ok', `Home now resolves to ${now}`)

  // Optional accessibility services; Android switches them off on every reinstall.
  for (const [on, svc] of [[req.inputKeyService, 'InputKeyService'], [req.homeKeyService, 'HomeKeyService']] as const) {
    if (on) await enableService(svc)
  }
  if (req.restoreKeyServices) {
    await T.sh(TASK, `pm grant ${PKG} android.permission.WRITE_SECURE_SETTINGS && echo restore-granted`)
  }
  return { ok: true, summary: 'Installed. Press Home on the remote to see it.', warnings }
}

/** Appends to enabled_accessibility_services without dropping other services. */
export async function enableService(name: 'InputKeyService' | 'HomeKeyService'): Promise<void> {
  const svc = `${PKG}/.${name}`
  // TCL firmware refuses to bind an app's accessibility service while the app is not running
  // unless it holds the AUTO_START app-op, so grant it first; other TVs ignore the op. Builds
  // name it AUTO_START or APP_AUTO_START, so set both, and flush app-ops to disk so the next
  // reboot keeps the grant. A service already listed was refused while the APK was replaced, and
  // binds again only once the list changes, so clear it, switch accessibility off and write it
  // back (as the theme restart does).
  await T.sh(TASK, `cmd appops set ${PKG} AUTO_START allow 2>/dev/null; cmd appops set ${PKG} APP_AUTO_START allow 2>/dev/null; appops write-settings 2>/dev/null; s=$(settings get secure enabled_accessibility_services); case "$s" in *${name}*) settings put secure enabled_accessibility_services ''; settings put secure accessibility_enabled 0; sleep 1; settings put secure enabled_accessibility_services "$s" ;; null|'') settings put secure enabled_accessibility_services ${svc} ;; *) settings put secure enabled_accessibility_services "$s:${svc}" ;; esac; settings put secure accessibility_enabled 1; echo ${name} enabled`)
}

export async function useStock(): Promise<ApplyResult> {
  const { installed } = await T.packageSets()
  const stock = KNOWN_STOCK_LAUNCHERS.find((p) => installed.has(p))
  if (!stock) return { ok: false, summary: 'No stock launcher this app knows is installed on the TV.', warnings: [] }
  const ok = await rollback(stock)
  return ok
    ? { ok, summary: `${stock} is Home again. The clean launcher stays installed; install again to switch back.`, warnings: [] }
    : { ok, summary: `Could not make ${stock} Home. Pick it in the TV's home settings.`, warnings: [] }
}
