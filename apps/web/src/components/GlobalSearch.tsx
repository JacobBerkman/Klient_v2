import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, routes } from '../lib/client'
import type { GlobalSearchPayload, GlobalSearchResult } from '../lib/types'

const DEBOUNCE_MS = 250
const RESULT_LIMIT = 20

const TYPE_LABELS: Record<GlobalSearchResult['type'], string> = {
  profile: 'Profile',
  household: 'Household',
  template: 'Template',
  form_template: 'Form template',
  submission: 'Submission'
}

function resultPath(result: GlobalSearchResult) {
  switch (result.type) {
    case 'profile':
      return `/profiles/${result.id}`
    case 'household':
      return `/households/${result.id}`
    case 'template':
      return `/templates/${result.id}`
    // Form templates have no detail route; the forms list is where they live.
    case 'form_template':
      return '/forms'
    case 'submission':
      return `/forms/submissions/${result.id}`
  }
}

function isEditableElement(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

// Firm-wide search (profiles, households, templates, submissions) behind
// Cmd/Ctrl+K. Combobox semantics: the input owns focus, arrow keys move the
// active option, Enter navigates, Esc / outside click closes (same dismissal
// pattern as NotificationBell).
export function GlobalSearch() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<GlobalSearchResult[]>([])
  const [activeIndex, setActiveIndex] = useState(-1)
  const [loading, setLoading] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const openPanel = useCallback(() => {
    setOpen(true)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  const closePanel = useCallback(() => {
    setOpen(false)
    setQuery('')
    setResults([])
    setActiveIndex(-1)
  }, [])

  // Global Cmd/Ctrl+K shortcut. Skipped when focus is in an editable element
  // so typing "k" with a modifier inside forms never hijacks the keystroke.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey)) {
        if (isEditableElement(event.target)) return
        event.preventDefault()
        openPanel()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [openPanel])

  // Close on outside click / Escape while open (NotificationBell pattern).
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        closePanel()
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePanel()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, closePanel])

  // 250ms debounce between keystrokes and the /api/search request.
  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    if (!trimmed) {
      setResults([])
      setActiveIndex(-1)
      setLoading(false)
      return
    }
    setLoading(true)
    // Requests can resolve out of order (a slow "jo" landing after a fast
    // "john smith"), so a stale response must never overwrite a newer one —
    // otherwise the list shows results for a query the user has moved on from
    // and Enter navigates to the wrong entity.
    let cancelled = false
    const timer = window.setTimeout(() => {
      void api
        .get<GlobalSearchPayload>(routes.search({ q: trimmed, limit: RESULT_LIMIT }))
        .then((payload) => {
          if (cancelled) return
          setResults(payload.results || [])
          setActiveIndex(payload.results?.length ? 0 : -1)
        })
        .catch(() => {
          if (cancelled) return
          setResults([])
          setActiveIndex(-1)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, open])

  const activateResult = useCallback(
    (result: GlobalSearchResult) => {
      closePanel()
      navigate(resultPath(result))
    },
    [closePanel, navigate]
  )

  const onInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((current) => (results.length ? (current + 1) % results.length : -1))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((current) => (results.length ? (current - 1 + results.length) % results.length : -1))
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        const result = results[activeIndex] || results[0]
        if (result) activateResult(result)
      }
    },
    [results, activeIndex, activateResult]
  )

  return (
    <div className="global-search" ref={containerRef}>
      <button
        type="button"
        className="global-search-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? closePanel() : openPanel())}
      >
        <span aria-hidden="true" className="global-search-icon">
          &#128269;
        </span>
        <span>Search</span>
        <kbd aria-hidden="true">Ctrl K</kbd>
      </button>
      {open ? (
        <div className="global-search-panel" role="dialog" aria-label="Global search">
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Global search"
            aria-expanded={results.length > 0}
            aria-controls="global-search-listbox"
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? `global-search-option-${activeIndex}` : undefined}
            placeholder="Search profiles, households, templates..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <ul className="global-search-results" id="global-search-listbox" role="listbox" aria-label="Search results">
            {loading ? (
              <li className="global-search-empty" role="presentation">
                Searching...
              </li>
            ) : results.length === 0 ? (
              <li className="global-search-empty" role="presentation">
                {query.trim() ? 'No matches.' : 'Type to search across the firm.'}
              </li>
            ) : (
              results.map((result, index) => (
                <li
                  key={`${result.type}-${result.id}`}
                  id={`global-search-option-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={index === activeIndex ? 'global-search-option is-active' : 'global-search-option'}
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => activateResult(result)}
                  >
                    <span className="global-search-option-title">{result.title || 'Untitled'}</span>
                    {result.subtitle ? <span className="global-search-option-subtitle">{result.subtitle}</span> : null}
                    <span className="global-search-option-type">{TYPE_LABELS[result.type]}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
