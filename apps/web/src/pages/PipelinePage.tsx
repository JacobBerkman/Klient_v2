import { startTransition, useDeferredValue, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, routes } from '../lib/client'
import { formatDateTime, profileName } from '../lib/format'
import { hasGuard } from '../lib/permissions'
import { useAsync } from '../lib/useAsync'
import type { BoardPayload, Profile } from '../lib/types'
import { useAuth } from '../app/auth'
import {
  Badge,
  ButtonLink,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHero,
  PageSection,
  SegmentedControl,
  Toolbar
} from '../components/ui'

export const handle = {
  title: 'Pipeline',
  subtitle: 'Dedicated board flow for stage management, filtering, and compact card actions.',
  breadcrumb: 'Pipeline'
}

interface PipelineData {
  board: BoardPayload
  clients: Profile[]
}

export function Component() {
  const { user } = useAuth()
  const [refreshKey, setRefreshKey] = useState(0)
  const [viewMode, setViewMode] = useState<'prospects' | 'clients'>('prospects')
  const [search, setSearch] = useState('')
  const [moveMessage, setMoveMessage] = useState('')
  const [draggingProfileId, setDraggingProfileId] = useState('')
  const [dropStage, setDropStage] = useState('')
  const deferredSearch = useDeferredValue(search)

  const { data, error, loading } = useAsync<PipelineData>(async () => {
    const [board, clients] = await Promise.all([
      api.get<BoardPayload>(routes.board()),
      api.get<Profile[]>(routes.profiles({ kind: 'client' }))
    ])
    return { board, clients }
  }, [refreshKey])

  async function moveProfile(profileId: string, stage: string) {
    if (!hasGuard(user, 'canMovePipeline')) return
    setMoveMessage('Moving stage...')
    try {
      await api.patch(routes.profileStage(profileId), { stage })
      setMoveMessage(`Moved to ${stage}.`)
      setRefreshKey((value) => value + 1)
    } catch (moveError) {
      setMoveMessage(moveError instanceof Error ? moveError.message : 'Stage move failed.')
    }
  }

  if (loading) return <LoadingState label="Loading pipeline" />
  if (error || !data) return <ErrorState title="Pipeline failed to load." detail={error?.message} />

  const searchValue = deferredSearch.trim().toLowerCase()
  const filteredColumns = data.board.columns.map((column) => ({
    ...column,
    cards: column.cards.filter((card) => {
      if (!searchValue) return true
      const haystack = `${profileName(card)} ${card.email || ''} ${card.phone || ''}`.toLowerCase()
      return haystack.includes(searchValue)
    })
  }))
  const filteredClients = data.clients.filter((client) => {
    if (!searchValue) return true
    const haystack = `${profileName(client)} ${client.email || ''} ${client.phone || ''}`.toLowerCase()
    return haystack.includes(searchValue)
  })

  return (
    <div className="stack">
      <PageHero
        eyebrow="Pipeline"
        title="Move prospects with less friction"
        subtitle="Switch views, search quickly, and move stages from compact cards while preserving the current board API."
        actions={
          <>
            <ButtonLink variant="primary" to="/profiles">
              Add profile
            </ButtonLink>
            <ButtonLink to="/analytics">Review analytics</ButtonLink>
          </>
        }
      />
      <PageSection
        title="Prospects and clients"
        subtitle="Switch between the stage-based prospect board and the active client roster."
        action={
          <SegmentedControl
            label="Pipeline view"
            value={viewMode}
            options={[
              { label: 'Prospects', value: 'prospects' },
              { label: 'Clients', value: 'clients' }
            ]}
            onChange={(value) => startTransition(() => setViewMode(value as typeof viewMode))}
          />
        }
      >
        <Toolbar label="Pipeline filters">
          <input
            aria-label="Search pipeline"
            placeholder="Search by name, email, or phone"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {moveMessage ? <Badge tone="info">{moveMessage}</Badge> : null}
        </Toolbar>

        {viewMode === 'prospects' ? (
          <div className="kanban-grid">
            {filteredColumns.map((column) => (
              <div
                key={column.stage}
                className={`kanban-column ${dropStage === column.stage ? 'is-drop-target' : ''}`.trim()}
                data-testid={`pipeline-column-${column.stage}`}
                onDragOver={(event) => {
                  if (!hasGuard(user, 'canMovePipeline')) return
                  event.preventDefault()
                  setDropStage(column.stage)
                }}
                onDragLeave={() => setDropStage('')}
                onDrop={(event) => {
                  event.preventDefault()
                  if (!draggingProfileId) return
                  void moveProfile(draggingProfileId, column.stage)
                  setDraggingProfileId('')
                  setDropStage('')
                }}
              >
                <div className="kanban-column-header">
                  <div className="row-between">
                    <strong>{column.label}</strong>
                    <Badge tone={column.cards.length ? 'info' : 'neutral'}>{column.cards.length}</Badge>
                  </div>
                  <p className="muted compact">Drop cards here or use each card stage selector.</p>
                </div>
                {column.cards.map((card) => (
                  <article
                    key={card.id}
                    className="kanban-card"
                    draggable={hasGuard(user, 'canMovePipeline')}
                    data-testid={`pipeline-card-${card.id}`}
                    onDragStart={() => setDraggingProfileId(card.id)}
                    onDragEnd={() => {
                      setDraggingProfileId('')
                      setDropStage('')
                    }}
                  >
                    <div className="row-between">
                      <strong>{profileName(card)}</strong>
                      <Badge tone="neutral">{card.kind}</Badge>
                    </div>
                    <p className="muted">{card.email || 'No email on file'}</p>
                    <div className="actions-row">
                      <Link className="text-link" to={`/profiles/${card.id}`}>
                        Open
                      </Link>
                      {hasGuard(user, 'canMovePipeline') ? (
                        <select
                          aria-label={`Move ${profileName(card)} stage`}
                          defaultValue={card.stage || column.stage}
                          onChange={(event) => void moveProfile(card.id, event.target.value)}
                        >
                          {data.board.stages.map((stage) => (
                            <option key={stage.id} value={stage.id}>
                              {stage.label}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </div>
                  </article>
                ))}
                {!column.cards.length ? (
                  <EmptyState title="No cards here." detail={`No matching prospects are in ${column.label}.`} />
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <DataTable caption="Active clients">
            <thead>
              <tr>
                <th>Client</th>
                <th>Household</th>
                <th>Stage</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredClients.map((client) => (
                <tr key={client.id}>
                  <td>
                    <strong>{profileName(client)}</strong>
                    <div className="muted">{client.email || 'No email on file'}</div>
                  </td>
                  <td>{client.householdId || 'Unlinked'}</td>
                  <td>{client.stage || 'Client'}</td>
                  <td>{formatDateTime(client.updatedAt || client.createdAt)}</td>
                  <td>
                    <Link className="text-link" to={`/profiles/${client.id}`}>
                      Open profile
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </PageSection>
    </div>
  )
}
