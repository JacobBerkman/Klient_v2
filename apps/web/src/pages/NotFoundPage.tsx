import { Link } from 'react-router-dom'
import { Card, EmptyState } from '../components/ui'

export const handle = {
  title: 'Not Found',
  breadcrumb: 'Not found'
}

export function Component() {
  return (
    <Card className="section-card">
      <EmptyState
        title="We couldn't find that route."
        detail="The new shell supports direct links, but this URL does not map to a known screen."
        action={
          <Link className="text-link" to="/dashboard">
            Go to dashboard
          </Link>
        }
      />
    </Card>
  )
}
