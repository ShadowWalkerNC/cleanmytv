// VIZIO SmartCast over the LAN: HTTPS with a self-signed cert, PIN pairing, an auth
// token kept next to the ADB key. Read the API doc at exiva/Vizio_SmartCast_API.
// Minimal surface: pair, power state, a few keys, input get/set. No registry yet:
// the VIZIO joins the device list when multi-TV orchestration needs it.
import { request as httpsRequest } from 'node:https'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { paths } from './paths'
import { log } from './log'
import type { ApplyResult, VizioKey } from '@shared/api'

const TASK = 'vizio'
const PORT = 7345
const DEVICE_ID = 'cleanmytv'
const DEVICE_NAME = 'CleanMyTV'

const KEYS: Record<VizioKey, { codeset: number; code: number }> = {
  'vol-down': { codeset: 5, code: 0 },
  'vol-up': { codeset: 5, code: 1 },
  mute: { codeset: 5, code: 4 },
  'input-next': { codeset: 7, code: 1 }
}

type Sender = (host: string, method: string, path: string, body?: unknown, auth?: string) => Promise<unknown>

function httpsSend(host: string, method: string, path: string, body?: unknown, auth?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = httpsRequest(
      {
        host,
        port: PORT,
        path,
        method,
        rejectUnauthorized: false, // The TV's cert is self-signed; this stays on the LAN.
        timeout: 8000,
        headers: {
          'Content-Type': 'application/json',
          ...(auth ? { Auth: auth } : {}),
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
        }
      },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`The VIZIO answered ${res.statusCode ?? 'nothing'} for ${path}.`))
            return
          }
          try {
            resolve(raw ? JSON.parse(raw) : null)
          } catch {
            reject(new Error(`The VIZIO answered ${path} with something unreadable.`))
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error(`The VIZIO at ${host} did not answer.`)))
    req.on('error', (e: Error) => reject(new Error(`Could not reach the VIZIO at ${host}: ${e.message}`)))
    if (data) req.write(data)
    req.end()
  })
}

let send: Sender = httpsSend
/** Tests swap the LAN for a stub. */
export function _setVizioSender(fn: Sender): void {
  send = fn
}

interface Saved {
  host: string
  auth: string
}

function saveFile(): string {
  return paths.data + '/vizio.json'
}

export function loadVizio(): Saved | null {
  try {
    const raw = JSON.parse(readFileSync(saveFile(), 'utf8')) as Partial<Saved>
    return typeof raw.host === 'string' && typeof raw.auth === 'string' ? { host: raw.host, auth: raw.auth } : null
  } catch {
    return null
  }
}

function saveVizio(host: string, auth: string): void {
  mkdirSync(paths.data, { recursive: true })
  writeFileSync(saveFile(), JSON.stringify({ host, auth }))
}

/** Dig a field out of the API's STATUS/ITEM/ITEMS wrappers. */
function field(res: unknown, name: string): unknown {
  if (!res || typeof res !== 'object') return undefined
  const r = res as Record<string, unknown>
  if (name in r) return r[name]
  const item = r.ITEM as Record<string, unknown> | undefined
  if (item && typeof item === 'object' && name in item) return item[name]
  const items = r.ITEMS as Array<Record<string, unknown>> | undefined
  if (Array.isArray(items)) for (const it of items) if (it && typeof it === 'object' && name in it) return it[name]
  return undefined
}

/** Starts pairing: a PIN appears on the TV. Returns the challenge token for pairFinish. */
export async function pairStart(host: string): Promise<{ host: string; token: number }> {
  const res = await send(host, 'PUT', '/pairing/start', { DEVICE_ID, DEVICE_NAME })
  const token = field(res, 'PAIRING_REQ_TOKEN')
  if (typeof token !== 'number') throw new Error('The VIZIO did not return a pairing token.')
  log(TASK, 'info', `pairing started with ${host}`)
  return { host, token }
}

/** Completes pairing with the on-screen PIN. Never logs the PIN or token. */
export async function pairFinish(host: string, token: number, pin: string): Promise<ApplyResult> {
  if (!/^\d{4,6}$/.test(pin.trim())) return { ok: false, summary: 'Enter the PIN shown on the TV.', warnings: [] }
  const res = await send(host, 'PUT', '/pairing/pair', {
    DEVICE_ID,
    CHALLENGE_TYPE: 1,
    RESPONSE_VALUE: pin.trim(),
    PAIRING_REQ_TOKEN: token
  })
  const auth = field(res, 'AUTH_TOKEN')
  if (typeof auth !== 'string' || !auth) return { ok: false, summary: 'The TV refused the PIN. Start pairing again for a fresh one.', warnings: [] }
  saveVizio(host, auth)
  log(TASK, 'info', `paired with ${host}`)
  return { ok: true, summary: 'Paired with the VIZIO.', warnings: [] }
}

function creds(): Saved {
  const s = loadVizio()
  if (!s) throw new Error('Pair with the VIZIO first.')
  return s
}

export async function power(): Promise<{ power: string }> {
  const { host, auth } = creds()
  const v = field(await send(host, 'GET', '/state/device/power_mode', undefined, auth), 'VALUE')
  return { power: v === 1 ? 'On' : v === 0 ? 'Off' : typeof v === 'string' ? v : 'unknown' }
}

export async function key(name: VizioKey): Promise<ApplyResult> {
  const k = KEYS[name]
  if (!k) return { ok: false, summary: `Unknown key: ${name}.`, warnings: [] }
  const { host, auth } = creds()
  await send(host, 'PUT', '/key_command/', { KEYLIST: [{ CODESET: k.codeset, CODE: k.code, ACTION: 'KEYPRESS' }] }, auth)
  log(TASK, 'info', `key ${name}`)
  return { ok: true, summary: `Sent ${name}.`, warnings: [] }
}

export async function currentInput(): Promise<{ input: string }> {
  const { host, auth } = creds()
  const v = field(await send(host, 'GET', '/menu_native/dynamic/tv_settings/devices/current_input', undefined, auth), 'VALUE')
  return { input: typeof v === 'string' ? v : 'unknown' }
}

/** Switches input. The TV wants the hash from a fresh GET back with the PUT. */
export async function setInput(name: string): Promise<ApplyResult> {
  const { host, auth } = creds()
  const res = await send(host, 'GET', '/menu_native/dynamic/tv_settings/devices/current_input', undefined, auth)
  const hash = field(res, 'HASHVAL')
  if (typeof hash !== 'number') return { ok: false, summary: 'The TV did not list its inputs.', warnings: [] }
  await send(host, 'PUT', '/menu_native/dynamic/tv_settings/devices/current_input', { REQUEST: 'MODIFY', VALUE: name, HASHVAL: hash }, auth)
  log(TASK, 'info', `input -> ${name}`)
  return { ok: true, summary: `Input set to ${name}.`, warnings: [] }
}
