import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'

/**
 * Theme preference handling for the whole SPA.
 *
 * The persisted preference is three-state ('light' | 'dark' | 'system') but the
 * DOM only ever sees the RESOLVED theme: document.documentElement.dataset.theme
 * is always 'light' or 'dark'. styles.css keys every token override off
 * [data-theme='dark'], so there is no duplicated media-query token block — the
 * 'system' preference is resolved here (and by the pre-paint script in
 * index.html) via matchMedia.
 */

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'klient-theme'

const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)'

function systemTheme(): ResolvedTheme {
  return window.matchMedia(DARK_SCHEME_QUERY).matches ? 'dark' : 'light'
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference
}

function readStoredPreference(): ThemePreference {
  // localStorage can throw (privacy modes, disabled storage) — fall back to
  // 'system' rather than breaking the render.
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
  } catch {
    return 'system'
  }
}

function applyResolvedTheme(theme: ResolvedTheme) {
  document.documentElement.dataset.theme = theme
}

interface ThemeContextValue {
  preference: ThemePreference
  resolvedTheme: ResolvedTheme
  setPreference: (preference: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference)
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(preference))

  // Apply the resolved theme whenever the preference changes, and, while the
  // preference is 'system', follow live OS scheme changes via matchMedia.
  useEffect(() => {
    const resolved = resolveTheme(preference)
    setResolvedTheme(resolved)
    applyResolvedTheme(resolved)
    if (preference !== 'system') return
    const media = window.matchMedia(DARK_SCHEME_QUERY)
    const handleChange = (event: MediaQueryListEvent) => {
      const next: ResolvedTheme = event.matches ? 'dark' : 'light'
      setResolvedTheme(next)
      applyResolvedTheme(next)
    }
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [preference])

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // Storage unavailable — the in-memory preference still applies this session.
    }
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolvedTheme, setPreference }),
    [preference, resolvedTheme, setPreference]
  )

  return createElement(ThemeContext.Provider, { value }, children)
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider.')
  }
  return context
}
