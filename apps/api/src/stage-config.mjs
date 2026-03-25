const DEFAULT_STAGE_KEYS = [
  'discovery',
  'gather_oi',
  'analysis',
  'advisor_proposal_meeting',
  'intake',
  'on_boarding',
  'investment_strategy',
  'completed',
  'drop_dead_lead',
  'drop_nurture'
]

export function createDefaultFirmStageConfig() {
  return {
    stages: DEFAULT_STAGE_KEYS.map((key, index) => ({
      id: key,
      key,
      label: key,
      active: true,
      order: index + 1
    }))
  }
}

export function normalizeFirmStageConfig(config) {
  const fallback = createDefaultFirmStageConfig()
  const sourceStages = Array.isArray(config?.stages) ? config.stages : []
  if (!sourceStages.length) return fallback

  const normalized = []
  sourceStages.forEach((stage, index) => {
    const key = String(stage?.key || stage?.id || '').trim()
    if (!key) return
    normalized.push({
      id: String(stage?.id || key).trim(),
      key,
      label: String(stage?.label || key).trim() || key,
      active: stage?.active !== false,
      order: Number(stage?.order ?? stage?.index ?? index + 1)
    })
  })

  if (!normalized.length) return fallback

  normalized.sort((a, b) => {
    const orderDiff = Number(a.order || 0) - Number(b.order || 0)
    if (orderDiff !== 0) return orderDiff
    return a.key.localeCompare(b.key)
  })

  return {
    stages: normalized.map((stage, index) => ({
      ...stage,
      order: index + 1
    }))
  }
}

export function getStageKey(stage) {
  return String(stage?.key || stage?.id || '').trim()
}

