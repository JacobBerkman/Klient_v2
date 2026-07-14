import { isRouteErrorResponse, useRouteError } from 'react-router-dom'
import { Card, ErrorState } from '../components/ui'

// Without an errorElement, a render throw or a failed lazy() chunk drops the
// user on React Router's unstyled default error screen. The most likely cause in
// practice is a redeploy: the open tab asks for a hashed asset that no longer
// exists, so reloading actually fixes it.
export function RouteError() {
  const error = useRouteError()

  const isChunkLoadFailure =
    error instanceof Error && /dynamically imported module|Importing a module script failed|chunk/i.test(error.message)

  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'An unexpected error occurred.'

  return (
    <Card className="section-card">
      <ErrorState
        title={isChunkLoadFailure ? 'This page is out of date.' : 'Something went wrong.'}
        detail={
          isChunkLoadFailure
            ? 'The app was updated while this tab was open. Reload to get the latest version.'
            : detail
        }
      />
      <div className="form-actions">
        <button className="primary" type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </Card>
  )
}
