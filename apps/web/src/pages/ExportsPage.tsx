import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, routes } from '../lib/client'
import { formatDateTime, profileName } from '../lib/format'
import { hasGuard } from '../lib/permissions'
import { useAsync } from '../lib/useAsync'
import type { DocumentTemplate, ExportJob, FormSubmission, Profile, QueueHealthPayload } from '../lib/types'
import { useAuth } from '../app/auth'
import {
  ActionPanel,
  ButtonLink,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  MetricCard,
  PageHero,
  PageSection,
  StatGroup,
  StatusBadge
} from '../components/ui'

export const handle = {
  title: 'Exports',
  subtitle: 'Status-filtered export operations with queue health, retries, and direct download actions.',
  breadcrumb: 'Exports'
}

interface ExportsPageData {
  exports: ExportJob[]
  templates: DocumentTemplate[]
  profiles: Profile[]
  submissions: FormSubmission[]
  queueHealth: QueueHealthPayload | null
}

export function Component() {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const [refreshKey, setRefreshKey] = useState(0)
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || '')
  const [profileFilter, setProfileFilter] = useState(searchParams.get('profileId') || '')
  const [statusMessage, setStatusMessage] = useState('')
  const [createForm, setCreateForm] = useState({
    templateId: '',
    clientId: searchParams.get('profileId') || '',
    submissionId: '',
    type: 'pdf'
  })

  if (!hasGuard(user, 'canReadExports')) {
    return (
      <ErrorState
        title="Export access required."
        detail="This route preserves role-based visibility and only loads export operations for advisor and admin roles."
      />
    )
  }

  const { data, error, loading } = useAsync<ExportsPageData>(async () => {
    const [exports, templates, profiles, submissions, queueHealth] = await Promise.all([
      api.get<ExportJob[]>(
        routes.exports({ status: statusFilter || undefined, profileId: profileFilter || undefined })
      ),
      api.get<DocumentTemplate[]>(routes.documentTemplates()),
      api.get<Profile[]>(routes.profiles({ kind: 'client' })),
      api.get<FormSubmission[]>(routes.formSubmissions()),
      hasGuard(user, 'canProcessExports')
        ? api.get<QueueHealthPayload>(routes.exportsQueueHealth()).catch(() => null)
        : Promise.resolve(null)
    ])
    return { exports, templates, profiles, submissions, queueHealth }
  }, [refreshKey, profileFilter, statusFilter, user])

  const profileById = useMemo(
    () => new Map((data?.profiles || []).map((profile) => [profile.id, profile])),
    [data?.profiles]
  )
  const templateById = useMemo(
    () => new Map((data?.templates || []).map((template) => [template.id, template])),
    [data?.templates]
  )
  const submissionOptions = useMemo(
    () =>
      (data?.submissions || []).filter(
        (submission) => !createForm.clientId || submission.clientId === createForm.clientId
      ),
    [createForm.clientId, data?.submissions]
  )

  async function handleCreateExport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setStatusMessage('')
    try {
      await api.post(routes.exports(), {
        templateId: createForm.templateId,
        clientId: createForm.clientId,
        submissionId: createForm.submissionId || undefined,
        type: createForm.type
      })
      setStatusMessage(`${createForm.type.toUpperCase()} export queued.`)
      setCreateForm((current) => ({ ...current, submissionId: '' }))
      setRefreshKey((value) => value + 1)
    } catch (createError) {
      setStatusMessage(createError instanceof Error ? createError.message : 'Unable to queue export.')
    }
  }

  async function handleProcessQueue() {
    setStatusMessage('')
    try {
      await api.post(routes.exportsProcess(), {})
      setStatusMessage('Queued export processing triggered.')
      setRefreshKey((value) => value + 1)
    } catch (processError) {
      setStatusMessage(processError instanceof Error ? processError.message : 'Queue processing failed.')
    }
  }

  async function handleRetry(exportId: string) {
    setStatusMessage('')
    try {
      await api.post(routes.exportRetry(exportId), {})
      setStatusMessage('Export retry requested.')
      setRefreshKey((value) => value + 1)
    } catch (retryError) {
      setStatusMessage(retryError instanceof Error ? retryError.message : 'Retry failed.')
    }
  }

  if (loading) return <LoadingState label="Loading exports" />
  if (error || !data) return <ErrorState title="Exports failed to load." detail={error?.message} />

  return (
    <div className="stack">
      <PageHero
        eyebrow="Exports"
        title="Queue, monitor, retry, and download deliverables"
        subtitle="Export work is separated by runtime state so advisors and operators can tell what is ready, blocked, or still processing."
        actions={hasGuard(user, 'canProcessExports') ? <ButtonLink to="/admin/ops">Runtime health</ButtonLink> : null}
      />

      <StatGroup>
        <MetricCard label="Visible exports" value={data.exports.length} hint="Current filtered result set" />
        <MetricCard
          label="Completed"
          value={data.exports.filter((entry) => entry.status === 'completed').length}
          hint="Ready for download"
        />
        <MetricCard
          label="Pending"
          value={
            data.exports.filter((entry) => ['queued', 'retrying', 'running'].includes(String(entry.status || '')))
              .length
          }
          hint="Waiting on the runtime"
        />
        <MetricCard
          label="Failures"
          value={data.exports.filter((entry) => ['failed', 'dead-letter'].includes(String(entry.status || ''))).length}
          hint="Needs retry or operator review"
        />
      </StatGroup>

      <div className="split-grid">
        <ActionPanel
          title="Queue export"
          subtitle="Create a new export from an approved template and client submission."
        >
          <form className="form-grid" onSubmit={handleCreateExport}>
            <Field label="Template">
              <select
                value={createForm.templateId}
                onChange={(event) => setCreateForm((current) => ({ ...current, templateId: event.target.value }))}
                required
              >
                <option value="">Select template</option>
                {data.templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Client">
              <select
                value={createForm.clientId}
                onChange={(event) => setCreateForm((current) => ({ ...current, clientId: event.target.value }))}
                required
              >
                <option value="">Select client</option>
                {data.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profileName(profile)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Submission" hint="Optional, but keeps the artifact tied to a specific form.">
              <select
                value={createForm.submissionId}
                onChange={(event) => setCreateForm((current) => ({ ...current, submissionId: event.target.value }))}
              >
                <option value="">Optional submission</option>
                {submissionOptions.map((submission) => (
                  <option key={submission.id} value={submission.id}>
                    {submission.templateId} - {submission.status}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Artifact type">
              <select
                value={createForm.type}
                onChange={(event) => setCreateForm((current) => ({ ...current, type: event.target.value }))}
              >
                <option value="pdf">PDF</option>
                <option value="xlsx">XLSX workbook</option>
              </select>
            </Field>
            <button type="submit" data-testid="create-export-submit" disabled={!hasGuard(user, 'canWriteExports')}>
              Queue export
            </button>
          </form>
        </ActionPanel>

        <ActionPanel
          title="Filters and runtime"
          subtitle="Narrow the queue and trigger processing without opening diagnostics."
        >
          <div className="form-grid">
            <Field label="Status">
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="">All statuses</option>
                <option value="queued">Queued</option>
                <option value="retrying">Retrying</option>
                <option value="running">Running</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
                <option value="dead-letter">Dead letter</option>
              </select>
            </Field>
            <Field label="Client">
              <select value={profileFilter} onChange={(event) => setProfileFilter(event.target.value)}>
                <option value="">All clients</option>
                {data.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profileName(profile)}
                  </option>
                ))}
              </select>
            </Field>
            {hasGuard(user, 'canProcessExports') ? (
              <button type="button" className="secondary-button" onClick={() => void handleProcessQueue()}>
                Process queue now
              </button>
            ) : (
              <Link className="text-link" to="/admin/ops">
                Open runtime health
              </Link>
            )}
          </div>
          <p className={statusMessage ? 'inline-notice inline-notice-info' : 'muted'}>
            {statusMessage ||
              'Queue health remains on the current backend and is surfaced here without changing the export runtime.'}
          </p>
          {data.queueHealth ? (
            <div className="pill-list">
              <StatusBadge status={`Queued ${String(data.queueHealth.queue?.pending || 0)}`} />
              <StatusBadge status={`Running ${String(data.queueHealth.queue?.running || 0)}`} />
              <StatusBadge status={`Failed ${String(data.queueHealth.queue?.failed || 0)}`} />
              <StatusBadge status={`Dead letter ${String(data.queueHealth.queue?.deadLetter || 0)}`} />
            </div>
          ) : null}
        </ActionPanel>
      </div>

      <PageSection
        title="Export queue"
        subtitle="Download-ready items, retries, and runtime status all live in one route."
      >
        {data.exports.length ? (
          <DataTable caption="Export queue by current filters">
            <thead>
              <tr>
                <th>Template</th>
                <th>Client</th>
                <th>Artifact</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.exports.map((job) => (
                <tr key={job.id}>
                  <td>
                    {templateById.get(String(job.templateId || ''))?.name || job.templateId || 'Unknown template'}
                  </td>
                  <td>{profileName(profileById.get(String(job.clientId || '')))}</td>
                  <td>
                    <div className="compact-stack">
                      <StatusBadge status={String(job.type || job.artifact?.format || 'pdf').toUpperCase()} />
                      {job.artifact?.renderer ? <span className="muted">{job.artifact.renderer}</span> : null}
                      {job.artifact?.fallbackReason ? (
                        <span className="muted">Fallback: {job.artifact.fallbackReason}</span>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <StatusBadge status={job.statusLabel || job.status || 'queued'} />
                    {job.artifact?.diagnostics?.length ? (
                      <div className="muted">{job.artifact.diagnostics.length} renderer diagnostics</div>
                    ) : null}
                  </td>
                  <td>
                    {job.attempts || 0} / {job.maxAttempts || 0}
                  </td>
                  <td>{formatDateTime(job.updatedAt || job.createdAt)}</td>
                  <td>
                    <div className="actions-row">
                      {job.artifactReady ? (
                        <a
                          className="text-link"
                          href={routes.exportDownload(job.id)}
                          data-testid={`export-download-${job.id}`}
                        >
                          Download
                        </a>
                      ) : null}
                      {job.retryState?.eligible && hasGuard(user, 'canProcessExports') ? (
                        <button type="button" className="ghost-button" onClick={() => void handleRetry(job.id)}>
                          Retry
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        ) : (
          <EmptyState title="No exports in this view." detail="Queue one above or loosen the current filters." />
        )}
      </PageSection>
    </div>
  )
}
