import {
  getFirmRow,
  listEventRowsByFirm,
  listExportQueueJobs,
  listFormSubmissionsByFirm,
  listHouseholdRows,
  listNoteRowsByFirm,
  listProfileRows,
  listStageChangeRowsByFirm,
  listUserRows
} from '../storage.mjs'
import { LEGACY_STAGE_BUCKET, SYNTHETIC_STAGE_CHANGE_TARGETS } from './constants.mjs'
import { average, csvCell, parseIso, requirePermission, resolveFirmAnalyticsStages, toIsoDate } from './helpers.mjs'

export function createAnalyticsDomain(ctx) {
  const { state, getFirmStageMetadata } = ctx
  return {
    buildAnalyticsSnapshot(user, filters = {}) {
      requirePermission(user, 'analytics:read')
      const startDate = toIsoDate(filters.startDate)
      const endDate = toIsoDate(filters.endDate)
      const cohortBy = filters.cohortBy || 'all'
      const cohortValue = filters.cohortValue ? String(filters.cohortValue) : null
      const nowMs = parseIso(process.env.TEST_NOW || '') || Date.now()

      const firm = getFirmRow(user.firmId)
      const stageConfig = resolveFirmAnalyticsStages(firm)
      const stageMetadata = getFirmStageMetadata(user.firmId)
      const toAnalyticsStage = (stage) => {
        const value = String(stage || '').trim()
        return value && stageConfig.stageIdSet.has(value) ? value : LEGACY_STAGE_BUCKET
      }

      // Archived profiles are soft-deleted: excluded from the funnel, stage
      // aging, profile/household counts, and advisor productivity. Filter them
      // out once at the source so every downstream aggregate stays coherent.
      const firmProfiles = listProfileRows({ firmId: user.firmId }).filter((entry) => !entry.archivedAt)

      // --- Sourced attribution (venue / event / year-over-year) --------------
      // Per-venue, per-event, and per-year prospect vs. converted-client counts.
      // A "converted" client is any kind==='client' profile carrying that
      // attribution (prospects are promoted to clients but keep their source).
      // Archived profiles are already excluded via firmProfiles. conversionRate =
      // clientCount / (prospectCount + clientCount). Events are resolved by
      // source.eventId; the venue/year cuts read source.sourceVenue/sourceDate.
      const eventsById = new Map(
        listEventRowsByFirm(user.firmId, { includeArchived: true }).map((event) => [event.id, event])
      )
      const attributionRate = (bucket) => {
        const total = bucket.prospectCount + bucket.clientCount
        return total ? Number((bucket.clientCount / total).toFixed(4)) : 0
      }
      const venueBuckets = new Map()
      const eventBuckets = new Map()
      const yearBuckets = new Map()
      for (const profile of firmProfiles) {
        const source = profile.source
        if (!source || typeof source !== 'object') continue
        const isClient = profile.kind === 'client'
        const bump = (bucket) => {
          if (isClient) bucket.clientCount += 1
          else bucket.prospectCount += 1
        }
        const venue = String(source.sourceVenue || '').trim()
        if (venue) {
          if (!venueBuckets.has(venue)) {
            venueBuckets.set(venue, {
              venue,
              city: String(source.sourceCity || '').trim() || null,
              prospectCount: 0,
              clientCount: 0
            })
          }
          bump(venueBuckets.get(venue))
        }
        const eventId = source.eventId ? String(source.eventId) : null
        if (eventId) {
          if (!eventBuckets.has(eventId)) {
            const event = eventsById.get(eventId)
            eventBuckets.set(eventId, {
              eventId,
              name: event?.name || null,
              venue: event?.venue || (venue || null),
              city: event?.city || (String(source.sourceCity || '').trim() || null),
              eventDate: event?.eventDate || (source.sourceDate || null),
              prospectCount: 0,
              clientCount: 0
            })
          }
          bump(eventBuckets.get(eventId))
        }
        const sourceDate = String(source.sourceDate || '').trim()
        const year = /^\d{4}-\d{2}-\d{2}$/.test(sourceDate) ? sourceDate.slice(0, 4) : null
        if (year) {
          if (!yearBuckets.has(year)) {
            yearBuckets.set(year, { year, prospectCount: 0, clientCount: 0 })
          }
          bump(yearBuckets.get(year))
        }
      }
      const sourcedAttribution = {
        byVenue: [...venueBuckets.values()]
          .map((bucket) => ({ ...bucket, conversionRate: attributionRate(bucket) }))
          .sort((a, b) => b.clientCount - a.clientCount || a.venue.localeCompare(b.venue)),
        byEvent: [...eventBuckets.values()]
          .map((bucket) => ({ ...bucket, conversionRate: attributionRate(bucket) }))
          .sort(
            (a, b) =>
              String(b.eventDate || '').localeCompare(String(a.eventDate || '')) ||
              b.clientCount - a.clientCount
          ),
        yearOverYear: [...yearBuckets.values()]
          .map((bucket) => ({ ...bucket, conversionRate: attributionRate(bucket) }))
          .sort((a, b) => a.year.localeCompare(b.year))
      }

      const prospects = firmProfiles.filter((entry) => {
        if (entry.kind !== 'prospect') return false
        const created = toIsoDate(entry.createdAt)
        if (startDate && created && created < startDate) return false
        if (endDate && created && created > endDate) return false
        if (cohortBy === 'stage' && cohortValue && (entry.stage || 'unassigned') !== cohortValue) return false
        if (cohortBy === 'advisor' && cohortValue && entry.advisorUserId !== cohortValue) return false
        // The UI has always offered a "Source" cohort, but only stage and
        // advisor were implemented -- picking Source silently returned
        // unfiltered numbers. Matches the same venue the attribution panel
        // buckets by (source.sourceVenue).
        if (cohortBy === 'source' && cohortValue) {
          const venue = String(entry.source?.sourceVenue || '').trim()
          if (venue !== cohortValue) return false
        }
        return true
      })
      const stageCounts = prospects.reduce((acc, profile) => {
        const stage = toAnalyticsStage(profile.stage)
        acc[stage] = (acc[stage] || 0) + 1
        return acc
      }, {})
      const totalProspects = prospects.length || 1
      const stageOrder = [...stageConfig.stageOrder]
      if (stageCounts[LEGACY_STAGE_BUCKET]) stageOrder.push(LEGACY_STAGE_BUCKET)
      const funnel = stageOrder.map((stage) => {
        const count = stageCounts[stage] || 0
        return { stage, count, conversionRate: Number((count / totalProspects).toFixed(4)) }
      })
      const firstStage = stageCounts[stageConfig.startStage] || 0
      const lastStage = stageCounts[stageConfig.endStage] || 0

      const firmStageChanges = listStageChangeRowsByFirm(user.firmId)
      // Genuine board moves only: strip the synthetic terminal markers (archive/
      // convert) so they never inflate advisorProductivity.stageMoves. Funnel and
      // aging read firmStageChanges directly because they already ignore these
      // rows structurally (prospect-only iteration + legacy bucketing).
      const realStageMoves = firmStageChanges.filter(
        (entry) => !SYNTHETIC_STAGE_CHANGE_TARGETS.has(String(entry.toStage || ''))
      )
      const stageEvents = firmStageChanges.slice().sort((a, b) => parseIso(a.changedAt) - parseIso(b.changedAt))
      const stageEntryTimes = new Map()
      stageEvents.forEach((event) => {
        const key = `${event.clientId}:${toAnalyticsStage(event.toStage)}`
        if (!stageEntryTimes.has(key)) stageEntryTimes.set(key, parseIso(event.changedAt))
      })
      const stageAgingMap = Object.fromEntries(
        stageMetadata.map((stage) => [stage.id, { count: 0, avgDays: 0, totalDays: 0 }])
      )
      prospects.forEach((profile) => {
        const stage = toAnalyticsStage(profile.stage)
        // Profiles whose stage is not part of the analytics stage config are
        // bucketed into LEGACY_STAGE_BUCKET (see toAnalyticsStage), which is
        // never present in stageMetadata — seed its accumulator on demand so
        // legacy-bucketed prospects age-aggregate instead of crashing.
        if (!stageAgingMap[stage]) stageAgingMap[stage] = { count: 0, avgDays: 0, totalDays: 0 }
        const enteredAt = stageEntryTimes.get(`${profile.id}:${stage}`) || parseIso(profile.createdAt)
        const ageDays = Math.max(0, (nowMs - enteredAt) / 86_400_000)
        stageAgingMap[stage].count += 1
        stageAgingMap[stage].totalDays += ageDays
      })
      Object.values(stageAgingMap).forEach((entry) => {
        if (entry.count) entry.avgDays = Number((entry.totalDays / entry.count).toFixed(2))
        delete entry.totalDays
      })
      const stageAgingOrdered = stageMetadata.map((stage) => ({
        stage: stage.id,
        stageId: stage.id,
        stageLabel: stage.label,
        isTerminal: stage.isTerminal,
        isDrop: stage.isDrop,
        count: stageAgingMap[stage.id]?.count || 0,
        avgDays: stageAgingMap[stage.id]?.avgDays || 0
      }))
      if (stageAgingMap[LEGACY_STAGE_BUCKET]) {
        // Mirror the funnel's conditional legacy bucket (stageOrder push above)
        // so stageAging/stageAgingOrdered stay consistent with the funnel.
        stageAgingOrdered.push({
          stage: LEGACY_STAGE_BUCKET,
          stageId: LEGACY_STAGE_BUCKET,
          stageLabel: 'Legacy / Unassigned',
          isTerminal: false,
          isDrop: false,
          count: stageAgingMap[LEGACY_STAGE_BUCKET].count,
          avgDays: stageAgingMap[LEGACY_STAGE_BUCKET].avgDays
        })
      }
      const stageAgingById = Object.fromEntries(
        stageAgingOrdered.map((entry) => [entry.stageId, { count: entry.count, avgDays: entry.avgDays }])
      )

      const templateIds = new Set(
        state.templateAggregates
          .filter((entry) => entry.firmId === user.firmId && entry.kind === 'form')
          .map((entry) => entry.id)
      )
      const formsByTemplate = {}
      templateIds.forEach((templateId) => {
        formsByTemplate[templateId] = { templateId, drafts: 0, submitted: 0, completionRate: 0 }
      })
      const firmSubmissions = listFormSubmissionsByFirm(user.firmId)
      const relevantSubmissions = firmSubmissions
        .filter((entry) => {
          const created = toIsoDate(entry.createdAt)
          if (startDate && created && created < startDate) return false
          if (endDate && created && created > endDate) return false
          return true
        })
      relevantSubmissions.forEach((submission) => {
        formsByTemplate[submission.templateId] ||= {
          templateId: submission.templateId,
          drafts: 0,
          submitted: 0,
          completionRate: 0
        }
        if (submission.status === 'submitted') formsByTemplate[submission.templateId].submitted += 1
        else formsByTemplate[submission.templateId].drafts += 1
      })
      Object.values(formsByTemplate).forEach((entry) => {
        const total = entry.drafts + entry.submitted
        entry.completionRate = total ? Number((entry.submitted / total).toFixed(4)) : 0
      })
      const formCompletionLatency = relevantSubmissions
        .filter((entry) => entry.status === 'submitted')
        .map((entry) => {
          const latencyHours = Number(((parseIso(entry.updatedAt) - parseIso(entry.createdAt)) / 3_600_000).toFixed(2))
          return {
            submissionId: entry.id,
            templateId: entry.templateId || 'unknown',
            latencyHours: Math.max(0, latencyHours)
          }
        })

      const latencyByTemplate = Object.values(
        formCompletionLatency.reduce((acc, entry) => {
          acc[entry.templateId] ||= { templateId: entry.templateId, submissions: 0, totalHours: 0 }
          acc[entry.templateId].submissions += 1
          acc[entry.templateId].totalHours += entry.latencyHours
          return acc
        }, {})
      ).map((entry) => ({
        templateId: entry.templateId,
        submissions: entry.submissions,
        avgHours: Number((entry.totalHours / entry.submissions).toFixed(2))
      }))

      const advisors = listUserRows({ firmId: user.firmId }).filter((entry) =>
        ['advisor', 'admin'].includes(entry.role)
      )
      // notes is a source-of-truth table now: read the firm's notes once and
      // count per-advisor in memory instead of scanning a blob-resident array.
      const firmNotes = listNoteRowsByFirm(user.firmId)
      const advisorProductivity = advisors.map((advisor) => {
        const assignedProfiles = firmProfiles.filter((entry) => entry.advisorUserId === advisor.id)
        const notesCount = firmNotes.filter((entry) => entry.createdByUserId === advisor.id).length
        const stageMoves = realStageMoves.filter((entry) => entry.changedByUserId === advisor.id).length
        const submissions = firmSubmissions.filter((entry) => entry.createdByUserId === advisor.id).length
        return {
          advisorUserId: advisor.id,
          advisorName: `${advisor.firstName} ${advisor.lastName}`,
          profilesManaged: assignedProfiles.length,
          notesAuthored: notesCount,
          stageMoves,
          formSubmissionsAuthored: submissions,
          productivityScore: assignedProfiles.length + notesCount + stageMoves + submissions
        }
      })

      const firmExportJobs = listExportQueueJobs().filter((entry) => entry.firmId === user.firmId)
      const exportJobs = firmExportJobs.filter((entry) => {
        const created = toIsoDate(entry.createdAt)
        if (startDate && created && created < startDate) return false
        if (endDate && created && created > endDate) return false
        return true
      })
      const advisorById = new Map(advisors.map((entry) => [entry.id, `${entry.firstName} ${entry.lastName}`]))
      const exportUsageByAdvisor = Object.values(
        exportJobs.reduce((acc, job) => {
          const advisorUserId = job.createdByUserId || job.metadata?.requestedByUserId || 'unknown'
          acc[advisorUserId] ||= { advisorUserId, advisorName: advisorById.get(advisorUserId) || 'Unknown', total: 0 }
          acc[advisorUserId].total += 1
          return acc
        }, {})
      )
      const exportUsageByFirm = {
        firmId: user.firmId,
        total: exportJobs.length,
        byStatus: exportJobs.reduce((acc, job) => {
          acc[job.status || 'unknown'] = (acc[job.status || 'unknown'] || 0) + 1
          return acc
        }, {})
      }

      const bottlenecks = stageAgingOrdered
        .filter((entry) => !entry.isTerminal && !entry.isDrop)
        .filter((entry) => entry.count > 0)
        .sort((a, b) => b.avgDays - a.avgDays)

      return {
        filters: { startDate, endDate, cohortBy, cohortValue },
        stageMetadata,
        stageCounts,
        stageCountsOrdered: stageMetadata.map((stage) => ({
          stage: stage.id,
          stageId: stage.id,
          stageLabel: stage.label,
          isTerminal: stage.isTerminal,
          isDrop: stage.isDrop,
          count: stageCounts[stage.id] || 0
        })),
        funnel,
        overallConversionRate: firstStage ? Number((lastStage / firstStage).toFixed(4)) : 0,
        stageAging: stageAgingById,
        stageAgingOrdered,
        bottlenecks,
        formCompletionRates: Object.values(formsByTemplate),
        formCompletionLatency: latencyByTemplate,
        advisorProductivity,
        sourcedAttribution,
        exportUsage: { byAdvisor: exportUsageByAdvisor, byFirm: exportUsageByFirm },
        profileCount: firmProfiles.length,
        householdCount: listHouseholdRows({ firmId: user.firmId }).filter((household) => !household.archivedAt).length,
        exportCount: firmExportJobs.length,
        templateCount: state.templateAggregates.filter((entry) => entry.firmId === user.firmId && entry.kind !== 'form')
          .length,
        avgProspectStageAgeDays: Number(
          average(
            stageAgingOrdered.filter((entry) => !entry.isTerminal && !entry.isDrop).map((entry) => entry.avgDays || 0)
          ).toFixed(2)
        )
      }
    },
    getAnalytics(user, filters = {}) {
      return this.buildAnalyticsSnapshot(user, filters)
    },
    getAnalyticsDashboard(user, filters = {}) {
      const snapshot = this.buildAnalyticsSnapshot(user, filters)
      return {
        filters: snapshot.filters,
        stageMetadata: snapshot.stageMetadata,
        funnel: snapshot.funnel,
        stageAging: snapshot.stageAging,
        stageAgingOrdered: snapshot.stageAgingOrdered,
        bottlenecks: snapshot.bottlenecks,
        formCompletionLatency: snapshot.formCompletionLatency,
        exportUsage: snapshot.exportUsage
      }
    },
    exportAnalyticsCsv(user, filters = {}) {
      const snapshot = this.buildAnalyticsSnapshot(user, filters)
      const rows = [['report', 'dimension', 'metric', 'value']]
      snapshot.funnel.forEach((entry) => rows.push(['funnel', entry.stage, 'count', entry.count]))
      snapshot.bottlenecks.forEach((entry) => rows.push(['stage_aging', entry.stage, 'avg_days', entry.avgDays]))
      snapshot.formCompletionLatency.forEach((entry) =>
        rows.push(['form_latency', entry.templateId, 'avg_hours', entry.avgHours])
      )
      snapshot.exportUsage.byAdvisor.forEach((entry) =>
        rows.push(['export_usage_advisor', entry.advisorName, 'total', entry.total])
      )
      Object.entries(snapshot.exportUsage.byFirm.byStatus).forEach(([status, count]) =>
        rows.push(['export_usage_firm', status, 'total', count])
      )
      return rows.map((row) => row.map(csvCell).join(',')).join('\n')
    }
  }
}
