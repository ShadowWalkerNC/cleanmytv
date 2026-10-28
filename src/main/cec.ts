// HDMI-CEC link state, read through the box that already talks to the display over
// the cable. Probe-only for now: sending CEC frames needs the onn. box in hand to
// verify which `cmd hdmi_control` subcommands its Android build answers.
import * as T from './tv'
import type { CecState } from '@shared/api'

/** The markers AOSP's own CEC tests grep for in `dumpsys hdmi_control`. */
export function parseCecDumpsys(out: string): { available: boolean; enabled: boolean } {
  const avail = /mIsCecAvailable:\s*(\S+)/i.exec(out)
  const flag = /hdmi_cec_enabled[^\d]*(\d)/i.exec(out)
  return {
    available: avail ? /^(true|1)$/i.test(avail[1]) : false,
    enabled: flag ? flag[1] === '1' : false
  }
}

export function parseCecState(dumpsysOut: string, settingOut: string): CecState {
  const d = parseCecDumpsys(dumpsysOut)
  const enabled = d.enabled || settingOut.trim() === '1'
  if (!d.available && !enabled) {
    return { available: false, enabled: false, detail: 'No CEC service answered on this TV.' }
  }
  if (!enabled) {
    return {
      available: d.available,
      enabled: false,
      detail: 'CEC answered but is switched off — turn on HDMI-CEC in the TV settings.'
    }
  }
  return { available: true, enabled: true, detail: 'CEC link up.' }
}

export async function cecState(): Promise<CecState> {
  const dumpsys = await T.tv().shell('dumpsys hdmi_control')
  const setting = await T.tv().shell('settings get global hdmi_control_enabled')
  return parseCecState(dumpsys, setting)
}
