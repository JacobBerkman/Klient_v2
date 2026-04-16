import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react'
import { api, routes } from '../lib/client'
import type { RuntimePayload, User } from '../lib/types'

type AuthStatus = 'loading' | 'authenticated' | 'anonymous'

interface LoginPayload {
  email: string
  password: string
  mfaChallengeToken?: string
  totpCode?: string
  backupCode?: string
}

interface RegisterPayload {
  firmName: string
  firstName: string
  lastName: string
  email: string
  password: string
}

interface PendingMfaLogin {
  email: string
  password: string
  challengeToken: string
}

interface AuthContextValue {
  status: AuthStatus
  user: User | null
  enableDemoMode: boolean
  pendingMfa: PendingMfaLogin | null
  refreshSession: () => Promise<User | null>
  login: (payload: LoginPayload) => Promise<{ mfaRequired: boolean; user: User | null }>
  register: (payload: RegisterPayload) => Promise<User>
  logout: () => Promise<void>
  clearPendingMfa: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: PropsWithChildren) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<User | null>(null)
  const [enableDemoMode, setEnableDemoMode] = useState(false)
  const [pendingMfa, setPendingMfa] = useState<PendingMfaLogin | null>(null)

  useEffect(() => {
    void api
      .get<RuntimePayload>(routes.runtime())
      .then((runtime) => setEnableDemoMode(Boolean(runtime.enableDemoMode)))
      .catch(() => setEnableDemoMode(false))
  }, [])

  useEffect(() => {
    void refreshSession()
  }, [])

  async function refreshSession() {
    try {
      const session = await api.get<{ user: User }>(routes.session())
      setUser(session.user)
      setStatus('authenticated')
      return session.user
    } catch {
      setUser(null)
      setStatus('anonymous')
      return null
    }
  }

  async function login(payload: LoginPayload) {
    const session = await api.post<{
      user: User
      csrfToken?: string
      mfaRequired?: boolean
      challengeToken?: string
    }>(routes.login(), payload, { skipCsrf: true })

    if (session.mfaRequired) {
      setPendingMfa({
        email: payload.email,
        password: payload.password,
        challengeToken: String(session.challengeToken || '')
      })
      setUser(null)
      setStatus('anonymous')
      return { mfaRequired: true, user: null }
    }

    setPendingMfa(null)
    setUser(session.user)
    setStatus('authenticated')
    return { mfaRequired: false, user: session.user }
  }

  async function register(payload: RegisterPayload) {
    const session = await api.post<{ user: User }>(routes.register(), payload, { skipCsrf: true })
    setPendingMfa(null)
    setUser(session.user)
    setStatus('authenticated')
    return session.user
  }

  async function logout() {
    try {
      await api.post(routes.logout(), {})
    } finally {
      api.clearCsrfToken()
      setPendingMfa(null)
      setUser(null)
      setStatus('anonymous')
    }
  }

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      enableDemoMode,
      pendingMfa,
      refreshSession,
      login,
      register,
      logout,
      clearPendingMfa: () => setPendingMfa(null)
    }),
    [enableDemoMode, pendingMfa, status, user]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside AuthProvider.')
  return context
}
