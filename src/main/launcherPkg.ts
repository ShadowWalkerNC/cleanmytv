// The CleanYourTV launcher's package name lives alone here on purpose: theme.ts and
// system.ts bake it into shell commands at module level, and importing it from launcher.ts
// would join the launcher <-> recovery import cycle and bake `undefined` instead.
export const PKG = 'com.gathin.tvhome'
