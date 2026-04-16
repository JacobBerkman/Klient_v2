import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, routes } from '../lib/client'
import { collaboratorSummary, formatDateTime, profileName } from '../lib/format'
import { hasGuard } from '../lib/permissions'
import { useAsync } from '../lib/useAsync'
import type { FormSubmission, FormTemplate, Profile } from '../lib/types'
import { useAuth } from '../app/auth'
import { Badge, Card, EmptyState, ErrorState, LoadingState, MetricCard, PageSection } from '../components/ui'

export const handle = {
  title: 'Forms',
  subtitle: 'Templates, drafts, submissions, and route-based editing instead of global shell widgets.',
  breadcrumb: 'Forms'
}

interface FormsPageData {
  templates: FormTemplate[]
  drafts: FormSubmission[]
  submissions: FormSubmission[]
  profiles: Profile[]
}

export function Component() {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const [refreshKey, setRefreshKey] = useState(0)
  const [statusMessage, setStatusMessage] = useState('')
  const [templateForm, setTemplateForm] = useState({
    name: '',
    description: ''
  })
  const [submissionForm, setSubmissionForm] = useState({
    clientId: searchParams.get('profileId') || '',
    templateId: '',
    status: 'draft'
  })

  const profileFilter = searchParams.get('profileId') || ''

  const { data, error, loading } = useAsync<FormsPageData>(async () => {
    const [templates, drafts, submissions, profiles] = await Promise.all([
      api.get<FormTemplate[]>(routes.formTemplates()),
      api.get<FormSubmission[]>(routes.formDrafts()),
      api.get<FormSubmission[]>(routes.formSubmissions()),
      api.get<Profile[]>(routes.profiles({ kind: 'client' }))
    ])
    return { templates, drafts, submissions, profiles }
  }, [refreshKey])

  const profileById = useMemo(
    () => new Map((data?.profiles || []).map((profile) => [profile.id, profile])),
    [data?.profiles]
  )

  const visibleDrafts = useMemo(() => {
    if (!data) return []
    return data.drafts.filter((entry) => !profileFilter || entry.clientId === profileFilter)
  }, [data, profileFilter])

  const visibleSubmissions = useMemo(() => {
    if (!data) return []
    return data.submissions.filter((entry) => !profileFilter || entry.clientId === profileFilter)
  }, [data, profileFilter])

  async function handleCreateTemplate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setStatusMessage('')
    try {
      await api.post(routes.formTemplates(), {
        name: templateForm.name,
        description: templateForm.description,
        sections: []
      })
      setTemplateForm({ name: '', description: '' })
      setStatusMessage('Form template created.')
      setRefreshKey((value) => value + 1)
    } catch (createError) {
      setStatusMessage(createError instanceof Error ? createError.message : 'Template creation failed.')
    }
  }

  async function handleCreateSubmission(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setStatusMessage('')
    try {
      await api.post(routes.formSubmissions(), {
        clientId: submissionForm.clientId,
        templateId: submissionForm.templateId,
        status: submissionForm.status,
        data: {}
      })
      setStatusMessage('Submission created.')
      setSubmissionForm((current) => ({ ...current, templateId: '', status: 'draft' }))
      setRefreshKey((value) => value + 1)
    } catch (createError) {
      setStatusMessage(createError instanceof Error ? createError.message : 'Submission creation failed.')
    }
  }

  if (loading) return <LoadingState label="Loading forms" />
  if (error || !data) return <ErrorState title="Forms failed to load." detail={error?.message} />

  return (
    <div className="stack">
      <div className="metrics-grid">
        <MetricCard label="Form templates" value={data.templates.length} hint="Reusable intake and review schemas" />
        <MetricCard label="Drafts" value={visibleDrafts.length} hint="Collaborative work in progress" />
        <MetricCard label="Submissions" value={visibleSubmissions.length} hint="Saved and submitted records" />
        <MetricCard
          label="Profile focus"
          value={profileFilter ? profileName(profileById.get(profileFilter)) : 'All profiles'}
          hint="Use profile-scoped deep links when needed"
        />
      </div>

      <div className="split-grid">
        <Card className="section-card">
          <h3>Create submission</h3>
          <form className="form-grid" onSubmit={handleCreateSubmission}>
            <label>
              <span>Client</span>
              <select
                value={submissionForm.clientId}
                onChange={(event) => setSubmissionForm((current) => ({ ...current, clientId: event.target.value }))}
                required
              >
                <option value="">Select a client</option>
                {data.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profileName(profile)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Template</span>
              <select
                value={submissionForm.templateId}
                onChange={(event) => setSubmissionForm((current) => ({ ...current, templateId: event.target.value }))}
                required
              >
                <option value="">Select a template</option>
                {data.templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Initial state</span>
              <select
                value={submissionForm.status}
                onChange={(event) => setSubmissionForm((current) => ({ ...current, status: event.target.value }))}
              >
                <option value="draft">Draft</option>
                <option value="submitted">Submitted</option>
              </select>
            </label>
            <button type="submit" disabled={!hasGuard(user, 'canWriteForms')}>
              Create submission
            </button>
          </form>
        </Card>

        <Card className="section-card">
          <h3>Create form template</h3>
          <form className="form-grid" onSubmit={handleCreateTemplate}>
            <label>
              <span>Name</span>
              <input
                value={templateForm.name}
                onChange={(event) => setTemplateForm((current) => ({ ...current, name: event.target.value }))}
                required
              />
            </label>
            <label>
              <span>Description</span>
              <textarea
                rows={3}
                value={templateForm.description}
                onChange={(event) => setTemplateForm((current) => ({ ...current, description: event.target.value }))}
              />
            </label>
            <button type="submit" disabled={!hasGuard(user, 'canWriteForms')}>
              Create form template
            </button>
          </form>
          <p className={statusMessage ? 'inline-notice inline-notice-info' : 'muted'}>
            {statusMessage || 'Form creation flows now live on form pages instead of the global shell.'}
          </p>
        </Card>
      </div>

      <PageSection title="Templates" subtitle="Current intake and workflow schemas available for draft creation.">
        {data.templates.length ? (
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Description</th>
                  <th>Sections</th>
                </tr>
              </thead>
              <tbody>
                {data.templates.map((template) => (
                  <tr key={template.id}>
                    <td>
                      <strong>{template.name}</strong>
                    </td>
                    <td>{template.description || 'No description'}</td>
                    <td>{template.sections.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No form templates yet."
            detail="Create one here, then route editing to a dedicated submission page."
          />
        )}
      </PageSection>

      <div className="split-grid">
        <PageSection
          title="Drafts"
          subtitle="Lock and collaborator state are visible here, with full editing on the detail route."
        >
          {visibleDrafts.length ? (
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <th>Draft</th>
                    <th>Client</th>
                    <th>Lock</th>
                    <th>Collaborators</th>
                    <th>Updated</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleDrafts.map((draft) => (
                    <tr key={draft.id}>
                      <td>
                        <strong>{draft.templateId}</strong>
                        <div className="muted">Revision {draft.revisionId || 1}</div>
                      </td>
                      <td>{profileName(profileById.get(draft.clientId))}</td>
                      <td>
                        {draft.lock ? (
                          <Badge tone="warning">Locked by {draft.lock.holderUserId}</Badge>
                        ) : (
                          <Badge tone="success">Open</Badge>
                        )}
                      </td>
                      <td>{collaboratorSummary(draft.collaborators)}</td>
                      <td>{formatDateTime(draft.updatedAt || draft.createdAt)}</td>
                      <td>
                        <Link
                          className="text-link"
                          data-testid={`submission-link-${draft.id}`}
                          to={`/forms/submissions/${draft.id}`}
                        >
                          Open draft
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No drafts in scope." detail="Draft collaboration now has its own routed editing flow." />
          )}
        </PageSection>

        <PageSection
          title="Submissions"
          subtitle="Shareable URLs support browser navigation, deep links, and direct review."
        >
          {visibleSubmissions.length ? (
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <th>Template</th>
                    <th>Client</th>
                    <th>Status</th>
                    <th>Updated</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleSubmissions.map((submission) => (
                    <tr key={submission.id}>
                      <td>{submission.templateId}</td>
                      <td>{profileName(profileById.get(submission.clientId))}</td>
                      <td>
                        <Badge tone={submission.status === 'submitted' ? 'success' : 'info'}>{submission.status}</Badge>
                      </td>
                      <td>{formatDateTime(submission.updatedAt || submission.createdAt)}</td>
                      <td>
                        <Link className="text-link" to={`/forms/submissions/${submission.id}`}>
                          Open detail
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="No submissions in scope."
              detail="Create a draft or submission from the form builder panel above."
            />
          )}
        </PageSection>
      </div>
    </div>
  )
}
