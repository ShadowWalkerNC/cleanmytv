export type StepId = 'guided' | 'setup' | 'devices' | 'analyze' | 'debloat' | 'launcher' | 'customise' | 'extras' | 'recovery' | 'finish'

export interface StepDef {
  id: StepId
  label: string
  sub: string
  needsTv: boolean
}

export const STEPS: StepDef[] = [
  // The guided one-button run (#9): composes the same IPC the step screens
  // use, so first-time owners get one path while every step stays reachable.
  { id: 'guided', label: 'Clean & launch', sub: 'One button, every step', needsTv: true },
  { id: 'setup', label: 'Setup', sub: 'Check and connect', needsTv: false },
  { id: 'devices', label: 'Devices', sub: 'TVs & capabilities', needsTv: false },
  { id: 'analyze', label: 'Analyze', sub: 'Health & Fix My TV', needsTv: true },
  { id: 'debloat', label: 'Clean up', sub: 'Turn off the bloat', needsTv: true },
  { id: 'launcher', label: 'Launcher', sub: 'Install the new Home', needsTv: true },
  { id: 'customise', label: 'Customise', sub: 'Order, wallpaper, layout', needsTv: true },
  { id: 'extras', label: 'TV extras', sub: 'Screensaver, DNS, remote', needsTv: true },
  { id: 'recovery', label: 'Recovery', sub: 'Snapshots & undo', needsTv: true },
  { id: 'finish', label: 'Finish', sub: 'Close the debug port', needsTv: false }
]
