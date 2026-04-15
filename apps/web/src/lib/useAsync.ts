import { useEffect, useState } from 'react'

interface AsyncState<T> {
  loading: boolean
  error: Error | null
  data: T | null
}

export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[]) {
  const [state, setState] = useState<AsyncState<T>>({
    loading: true,
    error: null,
    data: null
  })

  useEffect(() => {
    let active = true
    setState((current) => ({
      ...current,
      loading: true,
      error: null
    }))

    void loader()
      .then((data) => {
        if (!active) return
        setState({
          loading: false,
          error: null,
          data
        })
      })
      .catch((error: Error) => {
        if (!active) return
        setState({
          loading: false,
          error,
          data: null
        })
      })

    return () => {
      active = false
    }
  }, deps)

  return state
}
