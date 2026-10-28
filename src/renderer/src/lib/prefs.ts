// UI preferences, persisted per computer. Everything here is cosmetic: a missing or
// unreadable value always falls back to the default, never to an error.
import { useEffect, useState } from 'react'

const PREFIX = 'cleanmytv.'

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key)
  } catch {
    return null
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value)
  } catch {
    // Locked-down profile or no storage: prefs just don't persist.
  }
}

function useStringPref<T extends string>(key: string, initial: T, allowed: readonly T[]): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const raw = readPref(key)
    return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : initial
  })
  useEffect(() => writePref(key, value), [key, value])
  return [value, setValue]
}

export type SidebarMode = 'expanded' | 'rail'

export function useSidebarPref(): [SidebarMode, (v: SidebarMode) => void] {
  return useStringPref('sidebar', 'expanded', ['expanded', 'rail'])
}

export type ThemeMode = 'system' | 'light' | 'dark'

export function useThemePref(): [ThemeMode, (v: ThemeMode) => void] {
  return useStringPref('theme', 'system', ['system', 'light', 'dark'])
}
