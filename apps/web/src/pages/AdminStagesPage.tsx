import { useState } from 'react'
import { pipelineApi } from '../lib/client'
import { formatDateTime } from '../lib/format'
import { hasGuard } from '../lib/permissions'
import { useAsync } from '../lib/useAsync'
import type { PipelineStageRecord, PipelineStagesPayload } from '../lib/types'
import { useAuth } from '../app/auth'
import {
  ActionPanel,
  Badge,
  ButtonLink,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  InlineNotice,
  LoadingState,
  PageHero,
  PageSection
} from '../components/ui'

export const handle = {
  title: 'Stages',
  subtitle: 'Firm-level pipeline stage configuration: create, rename, reorder, and deactivate board columns.',
  breadcrumb: 'Stages'
}

type StatusMessage = {
  tone: 'info' | 'success' | 'danger'
  text: string
}

const DEACTIVATE_EXPLANATION =
  'Prospects already in this stage keep it, and its column stays on the pipeline board marked inactive. ' +
  'New moves into this stage are rejected, and new prospects default to the first active stage. ' +
  'Deactivation cannot be undone from this screen.'

export function Component() {
  const { user } = useAuth()
  const canManageStages = hasGuard(user, 'canMovePipeline')
  const [refreshKey, setRefreshKey] = useState(0)
  const [createForm, setCreateForm] = useState({ key: '', label: '', color: '' })
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null)
  const [busy, setBusy] = useState(false)
  const [editingStageId, setEditingStageId] = useState('')
  const [editingLabel, setEditingLabel] = useState('')
  const [editingColor, setEditingColor] = useState('')
  const [confirmingStageId, setConfirmingStageId] = useState('')

  const { data, error, loading } = useAsync<PipelineStagesPayload>(() => pipelineApi.listStages(), [refreshKey])

  async function runMutation(mutation: () => Promise<unknown>, successText: string) {
    setBusy(true)
    setStatusMessage(null)
    try {
      await mutation()
      setStatusMessage({ tone: 'success', text: successText })
      setRefreshKey((value) => value + 1)
      return true
    } catch (mutationError) {
      setStatusMessage({
        tone: 'danger',
        text: mutationError instanceof Error ? mutationError.message : 'Stage update failed.'
      })
      return false
    } finally {
      setBusy(false)
    }
  }

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const created = await runMutation(
      () =>
        pipelineApi.createStage({
          key: createForm.key.trim(),
          label: createForm.label.trim() || undefined,
          color: createForm.color.trim() || undefined
        }),
      'Stage created.'
    )
    if (created) setCreateForm({ key: '', label: '', color: '' })
  }

  function startRename(stage: PipelineStageRecord) {
    setConfirmingStageId('')
    setEditingStageId(stage.id)
    setEditingLabel(stage.label)
    setEditingColor(stage.color || '')
  }

  async function handleRenameSave(stage: PipelineStageRecord) {
    const saved = await runMutation(
      () =>
        pipelineApi.updateStageMetadata(stage.id, {
          label: editingLabel.trim(),
          color: editingColor.trim() || null
        }),
      'Stage updated.'
    )
    if (saved) setEditingStageId('')
  }

  async function handleReorder(stages: PipelineStageRecord[], index: number, direction: -1 | 1) {
    const targetIndex = index + direction
    if (targetIndex < 0 || targetIndex >= stages.length) return
    const stageIds = stages.map((stage) => stage.id)
    ;[stageIds[index], stageIds[targetIndex]] = [stageIds[targetIndex], stageIds[index]]
    await runMutation(() => pipelineApi.reorderStages(stageIds), 'Stage order updated.')
  }

  async function handleDeactivate(stage: PipelineStageRecord) {
    const deactivated = await runMutation(
      () => pipelineApi.deactivateStage(stage.id),
      `Stage "${stage.label}" deactivated.`
    )
    if (deactivated) setConfirmingStageId('')
  }

  if (!canManageStages) {
    return (
      <ErrorState
        title="Admin or advisor access required."
        detail="Stage configuration is limited to roles that can manage the pipeline board."
      />
    )
  }

  if (loading) return <LoadingState label="Loading pipeline stages" />
  if (error || !data) return <ErrorState title="Stages failed to load." detail={error?.message} />

  const stages = [...data.stages].sort((a, b) => a.order - b.order)
  const activeCount = stages.filter((stage) => stage.isActive).length

  return (
    <div className="stack">
      <PageHero
        eyebrow="Administration"
        title="Shape the pipeline board"
        subtitle="Stages defined here become the board columns. Order here is column order, and deactivated stages stop accepting new moves without hiding existing prospects."
        actions={
          <ButtonLink variant="primary" to="/pipeline">
            Open pipeline board
          </ButtonLink>
        }
      />
      {statusMessage ? <InlineNotice tone={statusMessage.tone}>{statusMessage.text}</InlineNotice> : null}
      <div className="split-grid">
        <ActionPanel
          title="Create stage"
          subtitle="New stages are added to the end of the board and start active immediately."
        >
          <form className="form-grid" onSubmit={(event) => void handleCreate(event)}>
            <Field label="Stage key" hint="Lowercase snake_case, e.g. proposal_review. Used as the stable column id.">
              <input
                value={createForm.key}
                onChange={(event) => setCreateForm((current) => ({ ...current, key: event.target.value }))}
                placeholder="proposal_review"
                required
              />
            </Field>
            <Field label="Stage label" hint="Shown on the board column. Defaults to a title-cased key.">
              <input
                value={createForm.label}
                onChange={(event) => setCreateForm((current) => ({ ...current, label: event.target.value }))}
                placeholder="Proposal Review"
              />
            </Field>
            <Field label="Color" hint="Optional accent, e.g. #0b5f54.">
              <input
                value={createForm.color}
                onChange={(event) => setCreateForm((current) => ({ ...current, color: event.target.value }))}
                placeholder="#0b5f54"
              />
            </Field>
            <button type="submit" disabled={busy}>
              Create stage
            </button>
          </form>
        </ActionPanel>

        <PageSection
          title="Stage order"
          subtitle="Up and down persist immediately through the reorder endpoint and apply to every stage, active or not."
        >
          {stages.length ? (
            <DataTable caption="Pipeline stages in board order">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Stage</th>
                  <th>Status</th>
                  <th>Updated</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {stages.map((stage, index) => (
                  <tr key={stage.id} data-testid={`stage-row-${stage.key}`}>
                    <td data-testid={`stage-order-${stage.key}`}>{stage.order}</td>
                    <td>
                      {editingStageId === stage.id ? (
                        <div className="form-grid">
                          <Field label="Label">
                            <input
                              aria-label={`New label for ${stage.label}`}
                              value={editingLabel}
                              onChange={(event) => setEditingLabel(event.target.value)}
                            />
                          </Field>
                          <Field label="Color">
                            <input
                              aria-label={`New color for ${stage.label}`}
                              value={editingColor}
                              onChange={(event) => setEditingColor(event.target.value)}
                              placeholder="#0b5f54"
                            />
                          </Field>
                        </div>
                      ) : (
                        <>
                          <strong>{stage.label}</strong>
                          <div className="muted compact">
                            {stage.key}
                            {stage.color ? ` · ${stage.color}` : ''}
                          </div>
                        </>
                      )}
                    </td>
                    <td>
                      <Badge tone={stage.isActive ? 'success' : 'warning'}>
                        {stage.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </td>
                    <td>{formatDateTime(stage.updatedAt || stage.createdAt)}</td>
                    <td>
                      {confirmingStageId === stage.id ? (
                        <div className="compact-stack">
                          <p className="muted compact">{DEACTIVATE_EXPLANATION}</p>
                          <div className="actions-row">
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={busy}
                              onClick={() => void handleDeactivate(stage)}
                            >
                              Confirm deactivate {stage.label}
                            </button>
                            <button type="button" className="ghost-button" onClick={() => setConfirmingStageId('')}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : editingStageId === stage.id ? (
                        <div className="actions-row">
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={busy}
                            onClick={() => void handleRenameSave(stage)}
                          >
                            Save {stage.label}
                          </button>
                          <button type="button" className="ghost-button" onClick={() => setEditingStageId('')}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="actions-row">
                          <button
                            type="button"
                            className="ghost-button"
                            aria-label={`Move ${stage.label} up`}
                            disabled={busy || index === 0}
                            onClick={() => void handleReorder(stages, index, -1)}
                          >
                            Up
                          </button>
                          <button
                            type="button"
                            className="ghost-button"
                            aria-label={`Move ${stage.label} down`}
                            disabled={busy || index === stages.length - 1}
                            onClick={() => void handleReorder(stages, index, 1)}
                          >
                            Down
                          </button>
                          <button
                            type="button"
                            className="ghost-button"
                            aria-label={`Rename ${stage.label}`}
                            disabled={busy}
                            onClick={() => startRename(stage)}
                          >
                            Rename
                          </button>
                          {stage.isActive ? (
                            <button
                              type="button"
                              className="ghost-button"
                              aria-label={`Deactivate ${stage.label}`}
                              disabled={busy || activeCount <= 1}
                              title={
                                activeCount <= 1
                                  ? 'At least one active stage is required for new prospects.'
                                  : undefined
                              }
                              onClick={() => {
                                setEditingStageId('')
                                setConfirmingStageId(stage.id)
                              }}
                            >
                              Deactivate
                            </button>
                          ) : null}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          ) : (
            <EmptyState
              title="No stages configured."
              detail="Create the first stage from the panel on this page to build the board."
            />
          )}
        </PageSection>
      </div>
    </div>
  )
}
