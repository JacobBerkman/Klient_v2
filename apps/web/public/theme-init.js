// Pre-paint theme resolution: apply the stored preference (or the OS scheme for
// 'system'/missing/invalid values) before first paint so a dark-mode session
// never flashes light. Mirrors src/lib/theme.ts.
//
// This lives in a same-origin file rather than an inline <script> so the
// Content-Security-Policy can use script-src 'self' without 'unsafe-inline'
// (an inline-script hash would break the moment the bundler re-minifies it).
try {
  var storedTheme = window.localStorage.getItem('klient-theme')
  var resolvedTheme =
    storedTheme === 'dark' || storedTheme === 'light'
      ? storedTheme
      : window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
  document.documentElement.dataset.theme = resolvedTheme
} catch (error) {
  document.documentElement.dataset.theme = 'light'
}
