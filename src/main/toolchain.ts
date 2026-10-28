// Everything the optional parts need, downloaded into the app's own folder on request: a JDK 17 and
// the Android SDK to build the launcher from source, the upstream source itself, and Google's
// platform-tools for the one-time Wireless debugging pairing. Nothing is installed system-wide.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { paths } from './paths'
import { log, progress } from './log'
import type { ApplyResult, ToolId } from '@shared/api'
import pin from '../../upstream.json'

const win = process.platform === 'win32'
const exe = (name: string): string => (win ? `${name}.exe` : name)

export const dirs = {
  get jdk(): string { return join(paths.tools, 'jdk') },
  get sdk(): string { return join(paths.tools, 'android-sdk') },
  get source(): string { return join(paths.tools, 'cleanyourtv') },
  get platformTools(): string { return join(paths.tools, 'platform-tools') },
  get gradleHome(): string { return join(paths.tools, 'gradle') }
}

/** JAVA_HOME of the downloaded JDK: the folder holding bin/java, found up to three levels down. */
export function javaHome(): string | null {
  const root = dirs.jdk
  if (!existsSync(root)) return null
  const walk = (dir: string, depth: number): string | null => {
    if (existsSync(join(dir, 'bin', exe('java')))) return dir
    if (depth === 0) return null
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try { if (statSync(p).isDirectory()) { const hit = walk(p, depth - 1); if (hit) return hit } } catch { /* unreadable */ }
    }
    return null
  }
  return walk(root, 3)
}

export const sdkReady = (): boolean => existsSync(join(dirs.sdk, 'platforms', 'android-34')) && existsSync(join(dirs.sdk, 'build-tools', '34.0.0'))
/** Ready only when it is the pinned commit; a source folder from an older or unpinned download is fetched again. */
export const sourceReady = (): boolean => {
  try { return readFileSync(join(dirs.source, '.upstream-commit'), 'utf8').trim() === pin.commit } catch { return false }
}
export const adbPath = (): string => join(dirs.platformTools, exe('adb'))
export const platformToolsReady = (): boolean => existsSync(adbPath())

export function run(task: string, cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; quiet?: boolean; redact?: string[] } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const hide = (s: string): string => (opts.redact ?? []).reduce((t, secret) => t.split(secret).join('••••••'), s)
    if (!opts.quiet) log(task, 'cmd', hide([cmd, ...args].join(' ')))
    // .bat files need cmd.exe on Windows, which takes one command line: quote anything with spaces
    // (C:\Users\Jane Doe\...) or the separators cmd.exe splits on. Nothing user-typed gets here.
    const bat = win && /\.(bat|cmd)$/i.test(cmd)
    const quote = (a: string): string => (/[\s;,&()^=]/.test(a) ? `"${a}"` : a)
    const child = bat
      ? spawn(quote(cmd), args.map(quote), { cwd: opts.cwd, env: { ...process.env, ...opts.env }, shell: true, windowsHide: true })
      : spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, windowsHide: true })
    let out = ''
    const onData = (b: Buffer): void => {
      const s = b.toString()
      out += s
      if (!opts.quiet) for (const line of s.split(/\r?\n/)) if (line.trim()) log(task, 'info', hide(line))
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, out }))
    if (opts.input !== undefined) { child.stdin.write(opts.input); child.stdin.end() }
  })
}

async function download(tool: ToolId, url: string, file: string): Promise<void> {
  mkdirSync(join(file, '..'), { recursive: true })
  log('download', 'cmd', `download ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  // Redirects are followed (Adoptium and GitHub use them), but never down to plain HTTP.
  if (!res.url.startsWith('https://')) throw new Error(`refusing a download that was redirected away from HTTPS (${res.url})`)
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`)
  const total = Number(res.headers.get('content-length')) || 0
  let received = 0
  let last = 0
  const body = Readable.fromWeb(res.body as never)
  body.on('data', (c: Buffer) => {
    received += c.length
    if (Date.now() - last > 150) { last = Date.now(); progress({ tool, received, total, phase: 'download' }) }
  })
  await pipeline(body, createWriteStream(file))
  progress({ tool, received, total, phase: 'download' })
}

/**
 * bsdtar (macOS, Windows 10 and later) reads .zip and .tar.gz; GNU tar on Linux reads only tar, so
 * zips go to unzip there.
 */
async function extract(tool: ToolId, archive: string, into: string): Promise<void> {
  progress({ tool, received: 0, total: 0, phase: 'extract' })
  mkdirSync(into, { recursive: true })
  // Windows' own bsdtar, not a GNU tar from Git that reads "C:" as a remote host.
  const tar = win ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  const r = process.platform === 'linux' && archive.endsWith('.zip')
    ? await run('download', 'unzip', ['-q', '-o', archive, '-d', into], { quiet: true })
    : await run('download', tar, ['-xf', archive, '-C', into], { quiet: true })
  if (r.code !== 0) throw new Error(`could not unpack ${archive}: ${r.out.trim()}`)
  rmSync(archive, { force: true })
}

function osArch(): { adoptOs: string; arch: string; googleOs: string; ptOs: string } {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64'
  if (process.platform === 'darwin') return { adoptOs: 'mac', arch, googleOs: 'mac', ptOs: 'darwin' }
  if (win) return { adoptOs: 'windows', arch, googleOs: 'win', ptOs: 'windows' }
  return { adoptOs: 'linux', arch, googleOs: 'linux', ptOs: 'linux' }
}

async function getJdk(): Promise<void> {
  const { adoptOs, arch } = osArch()
  rmSync(dirs.jdk, { recursive: true, force: true })
  const archive = join(paths.tools, `jdk.${win ? 'zip' : 'tar.gz'}`)
  await download('jdk', `https://api.adoptium.net/v3/binary/latest/17/ga/${adoptOs}/${arch}/jdk/hotspot/normal/eclipse`, archive)
  await extract('jdk', archive, dirs.jdk)
  if (!javaHome()) throw new Error('the JDK download did not contain bin/java')
}

async function getSdk(): Promise<void> {
  const home = javaHome()
  if (!home) throw new Error('Download the JDK first: the Android SDK manager runs on Java.')
  const { googleOs } = osArch()
  const tools = join(dirs.sdk, 'cmdline-tools')
  const sdkmanager = join(tools, 'latest', 'bin', win ? 'sdkmanager.bat' : 'sdkmanager')
  if (!existsSync(sdkmanager)) {
    // The archive name carries a build number, so read the current one from Google's repository index.
    const index = await fetch('https://dl.google.com/android/repository/repository2-3.xml')
    if (!index.ok || !index.url.startsWith('https://')) throw new Error(`could not read Google's SDK index (${index.status})`)
    const xml = await index.text()
    const names = [...xml.matchAll(new RegExp(`commandlinetools-${googleOs}-(\\d+)_latest\\.zip`, 'g'))]
    if (!names.length) throw new Error("could not find the Android command-line tools in Google's index")
    const best = names.sort((a, b) => Number(b[1]) - Number(a[1]))[0][0]
    const archive = join(paths.tools, best)
    await download('sdk', `https://dl.google.com/android/repository/${best}`, archive)
    const tmp = join(dirs.sdk, 'tmp-cmdline')
    rmSync(tmp, { recursive: true, force: true })
    await extract('sdk', archive, tmp)
    mkdirSync(tools, { recursive: true })
    rmSync(join(tools, 'latest'), { recursive: true, force: true })
    renameSync(join(tmp, 'cmdline-tools'), join(tools, 'latest'))
    rmSync(tmp, { recursive: true, force: true })
    if (!win) chmodSync(sdkmanager, 0o755)
  }
  progress({ tool: 'sdk', received: 0, total: 0, phase: 'install', message: 'Installing Android platform 34 and build tools' })
  const env = { JAVA_HOME: home }
  const sdkRoot = `--sdk_root=${dirs.sdk}`
  await run('download', sdkmanager, ['--licenses', sdkRoot], { env, input: 'y\n'.repeat(20), quiet: true })
  const r = await run('download', sdkmanager, ['--install', 'platforms;android-34', 'build-tools;34.0.0', sdkRoot], { env, input: 'y\n'.repeat(5) })
  if (r.code !== 0 || !sdkReady()) throw new Error('the Android SDK manager did not finish; see the log.')
}

/**
 * Content hash of directories, independent of archive format: sha256 over "path\0sha256(file)\n" for
 * every file, sorted by path; symlinks are refused. Same as scripts/tree-hash.mjs.
 */
export function treeHash(root: string, subdirs: string[]): string {
  const lines: string[] = []
  const walk = (rel: string): void => {
    const abs = join(root, rel)
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) throw new Error(`symlink in pinned tree: ${rel}`)
    if (st.isDirectory()) { for (const n of readdirSync(abs).sort()) walk(rel ? `${rel}/${n}` : n); return }
    if (st.isFile()) lines.push(`${rel}\0${createHash('sha256').update(readFileSync(abs)).digest('hex')}\n`)
  }
  for (const d of subdirs) walk(d)
  lines.sort()
  return createHash('sha256').update(lines.join('')).digest('hex')
}

/**
 * The launcher source at the upstream commit pinned in upstream.json, checked against its content hash
 * before anything in it runs: a moving branch of someone else's repository never reaches Gradle.
 */
async function getSource(): Promise<void> {
  const archive = join(paths.tools, 'cleanyourtv.tar.gz')
  await download('source', `https://codeload.github.com/${pin.repo}/tar.gz/${pin.commit}`, archive)
  const tmp = join(paths.tools, 'tmp-source')
  rmSync(tmp, { recursive: true, force: true })
  await extract('source', archive, tmp)
  const top = readdirSync(tmp).find((n) => n.startsWith('cleanyourtv'))
  if (!top) throw new Error('the source download is not the cleanyourtv repository')
  const got = treeHash(join(tmp, top), ['launcher'])
  if (got !== pin.launcherSha256) {
    rmSync(tmp, { recursive: true, force: true })
    throw new Error(`the launcher source does not match the pinned commit ${pin.commit.slice(0, 7)} (content hash ${got.slice(0, 12)}…); nothing was built.`)
  }
  writeFileSync(join(tmp, top, '.upstream-commit'), pin.commit + '\n')
  rmSync(dirs.source, { recursive: true, force: true })
  renameSync(join(tmp, top), dirs.source)
  rmSync(tmp, { recursive: true, force: true })
}

async function getPlatformTools(): Promise<void> {
  const { ptOs } = osArch()
  const archive = join(paths.tools, 'platform-tools.zip')
  await download('platform-tools', `https://dl.google.com/android/repository/platform-tools-latest-${ptOs}.zip`, archive)
  // Unpacked on its own, then moved: the archive cannot write over the JDK, SDK or source next to it.
  const tmp = join(paths.tools, 'tmp-platform-tools')
  rmSync(tmp, { recursive: true, force: true })
  await extract('platform-tools', archive, tmp)
  rmSync(dirs.platformTools, { recursive: true, force: true })
  renameSync(join(tmp, 'platform-tools'), dirs.platformTools)
  rmSync(tmp, { recursive: true, force: true })
  if (!platformToolsReady()) throw new Error('the platform-tools download did not contain adb')
}

export async function get(tool: ToolId): Promise<ApplyResult> {
  const getters: Record<ToolId, () => Promise<void>> = { jdk: getJdk, sdk: getSdk, source: getSource, 'platform-tools': getPlatformTools }
  if (!Object.hasOwn(getters, tool)) return { ok: false, summary: `unknown download: ${String(tool)}`, warnings: [] }
  mkdirSync(paths.tools, { recursive: true })
  try {
    await getters[tool]()
    progress({ tool, received: 1, total: 1, phase: 'done' })
    const what = { jdk: 'Java 17', sdk: 'Android SDK', source: 'Launcher source', 'platform-tools': 'Google platform-tools' }[tool]
    log('download', 'ok', `${what} is ready.`)
    return { ok: true, summary: `${what} is ready.`, warnings: [] }
  } catch (e) {
    const message = (e as Error).message
    progress({ tool, received: 0, total: 0, phase: 'error', message })
    log('download', 'error', message)
    return { ok: false, summary: message, warnings: [] }
  }
}

// ---- local build ------------------------------------------------------------------------------------

export const KEYSTORE = { password: 'cleanyourtv', alias: 'cleanyourtv' }

/**
 * Builds the launcher from source with the same signing key as the bundled APK, so either one installs
 * over the other. `sourceDir` is the upstream repository root; the APK lands at `outFile`.
 */
export async function buildApk(opts: { sourceDir: string; sdkDir: string; javaHome: string; keystore: string; outFile: string; gradleHome?: string; sourceRev?: string }): Promise<string> {
  const launcher = join(opts.sourceDir, 'launcher')
  // local.properties is a Java properties file: backslashes and the drive colon need escaping.
  writeFileSync(join(launcher, 'local.properties'), `sdk.dir=${opts.sdkDir.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}\n`)
  const gradlew = join(launcher, win ? 'gradlew.bat' : 'gradlew')
  if (!win) chmodSync(gradlew, 0o755)
  const r = await run('build', gradlew, [
    'assembleRelease', '--no-daemon', '--console=plain',
    `-Pandroid.injected.signing.store.file=${opts.keystore}`,
    `-Pandroid.injected.signing.store.password=${KEYSTORE.password}`,
    `-Pandroid.injected.signing.key.alias=${KEYSTORE.alias}`,
    `-Pandroid.injected.signing.key.password=${KEYSTORE.password}`
  ], {
    cwd: launcher,
    env: { JAVA_HOME: opts.javaHome, ANDROID_HOME: opts.sdkDir, ...(opts.gradleHome ? { GRADLE_USER_HOME: opts.gradleHome } : {}) }
  })
  const apk = join(launcher, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
  if (r.code !== 0 || !existsSync(apk)) throw new Error('Gradle build failed; see the log.')
  mkdirSync(join(opts.outFile, '..'), { recursive: true })
  copyFileSync(apk, opts.outFile)
  const gradle = readFileSync(join(launcher, 'app', 'build.gradle'), 'utf8')
  const versionName = /versionName\s+'([^']+)'/.exec(gradle)?.[1] ?? 'unknown'
  // The minimum SDK travels with the APK: the install asks the TV first, so a set too old for the
  // launcher is refused before anything is pushed or disabled (upstream #576).
  const minSdk = Number(/minSdk\s+(\d{1,3})/.exec(gradle)?.[1] ?? 0) || undefined
  // The upstream commit goes with the APK, so anyone can tell which reviewed source a build came from.
  const upstream = opts.sourceRev ?? (existsSync(join(opts.sourceDir, '.upstream-commit')) ? readFileSync(join(opts.sourceDir, '.upstream-commit'), 'utf8').trim() : 'unknown')
  writeFileSync(opts.outFile.replace(/\.apk$/, '.json'), JSON.stringify({ versionName, ...(minSdk ? { minSdk } : {}), upstream, built: new Date().toISOString() }, null, 2))
  return versionName
}

export async function buildLocal(): Promise<ApplyResult> {
  const home = javaHome()
  const missing = [!home && 'Java 17', !sdkReady() && 'Android SDK', !sourceReady() && 'launcher source'].filter(Boolean)
  if (missing.length) return { ok: false, summary: `Download first: ${missing.join(', ')}.`, warnings: [] }
  try {
    const version = await buildApk({ sourceDir: dirs.source, sdkDir: dirs.sdk, javaHome: home!, keystore: paths.keystore, outFile: paths.localApk, gradleHome: dirs.gradleHome })
    log('build', 'ok', `Built launcher ${version}.`)
    return { ok: true, summary: `Built launcher ${version} from source. Choose "Local build" to install it.`, warnings: [] }
  } catch (e) {
    return { ok: false, summary: (e as Error).message, warnings: [] }
  }
}

// ---- Wireless debugging pairing -------------------------------------------------------------------

/**
 * Pair with Google's adb, connect, and switch the TV to classic network ADB on 5555 (upstream
 * TROUBLESHOOTING: Google TVs whose USB debugging never opens 5555). Port 5555 lasts until reboot.
 */
export async function pair(host: string, pairPort: number, code: string, connectPort: number): Promise<ApplyResult> {
  const port = (p: unknown): boolean => Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 65535
  if (!/^[A-Za-z0-9.-]+$/.test(host) || !/^\d{6}$/.test(code) || !port(pairPort) || !port(connectPort)) {
    return { ok: false, summary: 'Enter the IP address, both ports and the 6-digit code shown on the TV.', warnings: [] }
  }
  if (!platformToolsReady()) {
    const got = await get('platform-tools')
    if (!got.ok) return got
  }
  const adb = adbPath()
  // The code goes in on stdin (adb asks for it when it is left off), so it never shows in the process
  // list; older adb that only reads it from the command line gets it there, kept out of the log.
  let p = await run('pair', adb, ['pair', `${host}:${pairPort}`], { input: code + '\n', redact: [code] })
  if (!/Successfully paired/i.test(p.out) && /pairing code/i.test(p.out)) {
    p = await run('pair', adb, ['pair', `${host}:${pairPort}`, code], { redact: [code] })
  }
  if (!/Successfully paired/i.test(p.out)) return { ok: false, summary: 'Pairing failed. Check the pairing port and code, which change each time the dialog opens.', warnings: [p.out.trim()] }
  const target = `${host}:${connectPort}`
  const c = await run('pair', adb, ['connect', target])
  if (!/connected to/i.test(c.out)) return { ok: false, summary: `Paired, but could not connect to ${target}. Use the port shown under Wireless debugging (not the pairing port).`, warnings: [c.out.trim()] }
  const t = await run('pair', adb, ['-s', target, 'tcpip', '5555'])
  await new Promise((r) => setTimeout(r, 3000))
  await run('pair', adb, ['disconnect'], { quiet: true })
  await run('pair', adb, ['kill-server'], { quiet: true })
  if (!/restarting|5555/i.test(t.out)) return { ok: false, summary: 'Connected, but the TV did not open port 5555.', warnings: [t.out.trim()] }
  return { ok: true, summary: 'Port 5555 is open until the TV reboots. Connecting now.', warnings: [] }
}
