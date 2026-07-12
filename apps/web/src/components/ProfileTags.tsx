import { useState } from 'react'
import { api, routes } from '../lib/client'
import type { Profile } from '../lib/types'

// Read-only chip list — used on prospect/client cards and rosters.
export function TagChips({ tags, className }: { tags?: string[] | null; className?: string }) {
  const list = Array.isArray(tags) ? tags.filter(Boolean) : []
  if (list.length === 0) return null
  return (
    <ul className={className ? `tag-list ${className}` : 'tag-list'} aria-label="Tags">
      {list.map((tag) => (
        <li key={tag} className="tag-chip">
          {tag}
        </li>
      ))}
    </ul>
  )
}

// Editable tags panel — used on the profile detail page. Add via input,
// remove via the chip's dismiss button. Calls the dedicated tag endpoints and
// reports status through an aria-live region.
export function ProfileTagsEditor({
  profileId,
  tags,
  canEdit,
  onChange
}: {
  profileId: string
  tags?: string[] | null
  canEdit: boolean
  onChange?: (tags: string[]) => void
}) {
  const [value, setValue] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const list = Array.isArray(tags) ? tags.filter(Boolean) : []

  async function addTag(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const tag = value.trim()
    if (!tag || busy) return
    setBusy(true)
    try {
      const updated = await api.post<Profile>(routes.profileTags(profileId), { tag })
      setValue('')
      setStatus(`Added tag "${tag}".`)
      onChange?.(Array.isArray(updated.tags) ? updated.tags : [])
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not add tag.')
    } finally {
      setBusy(false)
    }
  }

  async function removeTag(tag: string) {
    if (busy) return
    setBusy(true)
    try {
      const updated = await api.delete<Profile>(routes.profileTag(profileId, tag))
      setStatus(`Removed tag "${tag}".`)
      onChange?.(Array.isArray(updated.tags) ? updated.tags : [])
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not remove tag.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="profile-tags">
      {list.length ? (
        <ul className="tag-list" aria-label="Profile tags">
          {list.map((tag) => (
            <li key={tag} className="tag-chip">
              <span>{tag}</span>
              {canEdit ? (
                <button
                  type="button"
                  className="tag-remove"
                  aria-label={`Remove tag ${tag}`}
                  onClick={() => void removeTag(tag)}
                  disabled={busy}
                >
                  &times;
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No tags yet.</p>
      )}
      {canEdit ? (
        <form className="tag-input-row" onSubmit={addTag}>
          <input
            type="text"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Add a tag"
            aria-label="Add a tag"
            maxLength={40}
            disabled={busy}
          />
          <button type="submit" className="secondary-button" disabled={busy || !value.trim()}>
            Add
          </button>
        </form>
      ) : null}
      <span className="visually-hidden" aria-live="polite" role="status">
        {status}
      </span>
    </div>
  )
}
