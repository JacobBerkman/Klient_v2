import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { router } from './app/router'
import { AuthProvider } from './app/auth'
import { ThemeProvider } from './lib/theme'
import { ToastProvider } from './components/toast'
// Self-hosted brand fonts (bundled locally by @fontsource — no runtime CDN).
// Cabin for headings, Roboto for body. Latin subsets only to keep the bundle lean.
import '@fontsource/cabin/latin-500.css'
import '@fontsource/cabin/latin-600.css'
import '@fontsource/cabin/latin-700.css'
import '@fontsource/roboto/latin-400.css'
import '@fontsource/roboto/latin-500.css'
import '@fontsource/roboto/latin-700.css'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {/* ThemeProvider wraps AuthProvider so auth/login screens theme too. */}
    <ThemeProvider>
      <AuthProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </AuthProvider>
    </ThemeProvider>
  </React.StrictMode>
)
