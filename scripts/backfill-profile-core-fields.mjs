import { loadState, saveState } from '../apps/api/src/storage.mjs'

function toNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeExtensions(profile) {
  if (profile.extensions && typeof profile.extensions === 'object' && !Array.isArray(profile.extensions)) {
    return {
      schemaVersion: profile.extensions.schemaVersion || profile.extensions.schema?.version || '1.0.0',
      schema: profile.extensions.schema || null,
      values:
        profile.extensions.values && typeof profile.extensions.values === 'object'
          ? { ...profile.extensions.values }
          : {}
    }
  }
  return {
    schemaVersion: '1.0.0',
    schema: null,
    values: profile.customProfile && typeof profile.customProfile === 'object' ? { ...profile.customProfile } : {}
  }
}

function normalizeFinancialSummary(profile, extensions) {
  const ext = extensions.values || {}
  const investableAssets = toNumber(profile.financialSummary?.investableAssets ?? ext.investableAssets) || 0
  const annualIncome = toNumber(profile.financialSummary?.annualIncome ?? ext.annualIncome) || 0
  const totalAssets = toNumber(profile.financialSummary?.totalAssets ?? ext.totalAssets ?? investableAssets) || 0
  const totalLiabilities = toNumber(profile.financialSummary?.totalLiabilities ?? ext.totalLiabilities) || 0
  const netWorth = toNumber(profile.financialSummary?.netWorth ?? ext.netWorth ?? totalAssets - totalLiabilities) || 0
  return { investableAssets, annualIncome, totalAssets, totalLiabilities, netWorth }
}

const state = loadState(() => ({}))
let processed = 0
let changed = 0
let extensionBackfilled = 0
let financialBackfilled = 0
let statusBackfilled = 0

for (const profile of state.profiles || []) {
  processed += 1
  const before = JSON.stringify(profile)
  const extensions = normalizeExtensions(profile)
  const financialSummary = normalizeFinancialSummary(profile, extensions)
  if (!profile.extensions) extensionBackfilled += 1
  if (!profile.financialSummary) financialBackfilled += 1
  if (!profile.status) statusBackfilled += 1
  profile.extensions = extensions
  profile.financialSummary = financialSummary
  profile.status = profile.status || (profile.kind === 'client' ? 'active' : 'new')
  delete profile.customProfile
  const after = JSON.stringify(profile)
  if (before !== after) changed += 1
}

saveState(state)

const report = {
  ok: true,
  processedProfiles: processed,
  changedProfiles: changed,
  backfill: {
    extensions: extensionBackfilled,
    financialSummary: financialBackfilled,
    status: statusBackfilled
  },
  verification: {
    withoutExtensions: (state.profiles || []).filter((profile) => !profile.extensions).length,
    withoutFinancialSummary: (state.profiles || []).filter((profile) => !profile.financialSummary).length,
    withoutStatus: (state.profiles || []).filter((profile) => !profile.status).length
  }
}

console.log(JSON.stringify(report, null, 2))
