import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { TemplateMappingPathGroup } from '../lib/types'

interface FlatOption {
  path: string
  label: string
  groupKey: string
  custom?: boolean
}

interface SourcePathPickerProps {
  value: string
  onChange: (value: string) => void
  /** Grouped catalog from GET /api/templates/:id/mapping-paths; null while loading or unavailable. */
  groups: TemplateMappingPathGroup[] | null
  /** Accessible name for the combobox input, e.g. "Source path for firstName". */
  label: string
  inputTestId?: string
  placeholder?: string
  disabled?: boolean
}

/**
 * Accessible combobox (role=combobox + listbox) for picking a mapping source
 * path. Follows the NotificationBell popover conventions (outside-click and
 * Escape close) and adds filter-as-you-type across path + label, grouped
 * sections, keyboard navigation, and a free-text escape hatch: a typed value
 * that matches no catalog path is offered as a "Use custom path" option and is
 * also committed on blur/outside-click so manual entry always works.
 *
 * The listbox is position:fixed (recomputed on scroll/resize) so it is not
 * clipped by the mapping table's overflow container.
 */
export function SourcePathPicker({
  value,
  onChange,
  groups,
  label,
  inputTestId,
  placeholder = 'e.g. profile.firstName',
  disabled
}: SourcePathPickerProps) {
  const id = useId()
  const listboxId = `${id}-listbox`
  const containerRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [open, setOpen] = useState(false)
  // null = the user has not typed since opening; the input shows the committed value.
  const [query, setQuery] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({})

  const displayValue = query === null ? value : query
  const filterText = (query || '').trim().toLowerCase()
  const typedValue = (query || '').trim()

  const visibleGroups = useMemo(() => {
    if (!groups) return []
    return groups
      .map((group) => ({
        ...group,
        paths: filterText
          ? group.paths.filter(
              (option) =>
                option.path.toLowerCase().includes(filterText) ||
                String(option.label || '')
                  .toLowerCase()
                  .includes(filterText)
            )
          : group.paths
      }))
      .filter((group) => group.paths.length > 0)
  }, [groups, filterText])

  // Free-text escape hatch: typed text that is not an exact catalog path becomes
  // a selectable "Use custom path" option at the end of the list.
  const customOption = useMemo<FlatOption | null>(() => {
    if (!typedValue) return null
    const exactMatch = (groups || []).some((group) => group.paths.some((option) => option.path === typedValue))
    if (exactMatch) return null
    return { path: typedValue, label: 'Use custom path', groupKey: 'custom-entry', custom: true }
  }, [groups, typedValue])

  const flatOptions = useMemo(() => {
    const options: FlatOption[] = []
    for (const group of visibleGroups) {
      for (const option of group.paths) {
        options.push({ path: option.path, label: option.label || option.path, groupKey: group.key })
      }
    }
    if (customOption) options.push(customOption)
    return options
  }, [visibleGroups, customOption])

  const updatePosition = useCallback(() => {
    const input = inputRef.current
    if (!input) return
    const rect = input.getBoundingClientRect()
    // Clamp within the viewport: prefer opening below the input, but flip
    // above when the space below cannot fit the list, and cap the height to
    // the available space so every option stays reachable (the listbox has
    // overflow-y: auto).
    const viewportHeight = window.innerHeight
    const spaceBelow = viewportHeight - rect.bottom - 8
    const spaceAbove = rect.top - 8
    const preferredMaxHeight = 320 // matches the 20rem CSS cap
    const openAbove = spaceBelow < 160 && spaceAbove > spaceBelow
    const maxHeight = Math.min(preferredMaxHeight, Math.max(120, openAbove ? spaceAbove : spaceBelow))
    setPopoverStyle({
      position: 'fixed',
      ...(openAbove ? { bottom: viewportHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      left: rect.left,
      minWidth: rect.width,
      maxHeight
    })
  }, [])

  const openList = useCallback(() => {
    if (disabled) return
    setOpen(true)
  }, [disabled])

  const closeList = useCallback(() => {
    setOpen(false)
    setActiveIndex(-1)
  }, [])

  const commitTyped = useCallback(() => {
    if (query !== null && query.trim() !== value) {
      onChange(query.trim())
    }
    setQuery(null)
  }, [query, value, onChange])

  const selectOption = useCallback(
    (option: FlatOption) => {
      onChange(option.path)
      setQuery(null)
      closeList()
      inputRef.current?.focus()
    },
    [onChange, closeList]
  )

  // Keep the fixed-position popover glued to the input while the page scrolls
  // or resizes (the mapping table lives in an overflow container).
  useEffect(() => {
    if (!open) return
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, updatePosition])

  // Close on outside click, committing any typed free-text first.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        commitTyped()
        closeList()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open, commitTyped, closeList])

  // Reset the highlighted option whenever the filtered result set changes.
  useEffect(() => {
    if (!open) return
    setActiveIndex(flatOptions.length ? 0 : -1)
  }, [open, filterText, flatOptions.length])

  // Keep the active option scrolled into view during keyboard navigation.
  useEffect(() => {
    if (!open || activeIndex < 0) return
    document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex, id])

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        openList()
        return
      }
      if (!flatOptions.length) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((current) => {
        if (current < 0) return delta > 0 ? 0 : flatOptions.length - 1
        return (current + delta + flatOptions.length) % flatOptions.length
      })
      return
    }
    if (event.key === 'Home' && open && flatOptions.length) {
      event.preventDefault()
      setActiveIndex(0)
      return
    }
    if (event.key === 'End' && open && flatOptions.length) {
      event.preventDefault()
      setActiveIndex(flatOptions.length - 1)
      return
    }
    if (event.key === 'Enter') {
      if (!open) return
      event.preventDefault()
      const option = activeIndex >= 0 ? flatOptions[activeIndex] : null
      if (option) {
        selectOption(option)
      } else {
        commitTyped()
        closeList()
      }
      return
    }
    if (event.key === 'Escape') {
      if (!open) return
      event.preventDefault()
      setQuery(null)
      closeList()
      return
    }
    if (event.key === 'Tab') {
      commitTyped()
      closeList()
    }
  }

  // Options are rendered inside labeled group sections; this counter keeps the
  // rendered order aligned with flatOptions for aria-activedescendant ids.
  let optionIndex = -1
  const renderOption = (option: FlatOption) => {
    optionIndex += 1
    const index = optionIndex
    const isActive = index === activeIndex
    const isSelected = !option.custom && Boolean(value) && option.path === value
    return (
      <li
        key={`${option.groupKey}-${option.path}`}
        id={`${id}-option-${index}`}
        role="option"
        aria-selected={isSelected}
        data-path={option.path}
        className={`source-path-option${isActive ? ' is-active' : ''}${isSelected ? ' is-selected' : ''}${
          option.custom ? ' is-custom' : ''
        }`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => selectOption(option)}
        onMouseEnter={() => setActiveIndex(index)}
      >
        <span className="source-path-option-main">
          <span className="source-path-option-label">{option.label}</span>
          <code className="source-path-option-path">{option.path}</code>
        </span>
        {isSelected ? (
          <span className="source-path-option-check" aria-hidden="true">
            &#10003;
          </span>
        ) : null}
      </li>
    )
  }

  return (
    <div className="source-path-picker" ref={containerRef}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-haspopup="listbox"
        aria-autocomplete="list"
        aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
        aria-label={label}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={displayValue}
        data-testid={inputTestId}
        onClick={openList}
        onChange={(event) => {
          setQuery(event.target.value)
          if (!open) openList()
        }}
        onKeyDown={handleKeyDown}
      />
      {open ? (
        <ul
          className="source-path-listbox"
          role="listbox"
          id={listboxId}
          aria-label={`${label} suggestions`}
          style={popoverStyle}
          data-testid="source-path-listbox"
        >
          {groups === null ? (
            <li className="source-path-empty" role="presentation">
              Suggested paths are unavailable. Type a source path manually.
            </li>
          ) : null}
          {visibleGroups.map((group) => (
            <li key={group.key} role="group" aria-labelledby={`${id}-group-${group.key}`} className="source-path-group">
              <div id={`${id}-group-${group.key}`} className="source-path-group-label" role="presentation">
                {group.label}
              </div>
              <ul role="presentation" className="source-path-group-list">
                {group.paths.map((option) =>
                  renderOption({ path: option.path, label: option.label || option.path, groupKey: group.key })
                )}
              </ul>
            </li>
          ))}
          {customOption ? renderOption(customOption) : null}
          {groups !== null && !visibleGroups.length && !customOption ? (
            <li className="source-path-empty" role="presentation">
              No paths match the current filter.
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}
