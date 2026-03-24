const STAGE_ORDER = ['discovery', 'gather_oi', 'analysis', 'advisor_proposal_meeting', 'intake', 'on_boarding', 'investment_strategy', 'completed'];

function parseDate(value, fallback = null) {
  if (!value) return fallback;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : fallback;
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const rank = Math.ceil((p / 100) * sortedValues.length) - 1;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, rank));
  return Number(sortedValues[idx].toFixed(2));
}

function avg(values) {
  if (!values.length) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function parseFilters(raw = {}) {
  const startTime = parseDate(raw.startDate, null);
  const endTime = parseDate(raw.endDate, null);
  const cohortBy = String(raw.cohortBy || 'sourceVenue');
  const cohortValue = raw.cohortValue ? String(raw.cohortValue) : '';
  const slaTargetDays = Math.max(1, Number(raw.slaTargetDays || 14));
  return {
    startDate: raw.startDate || null,
    endDate: raw.endDate || null,
    startTime,
    endTime,
    cohortBy,
    cohortValue,
    slaTargetDays
  };
}

function inRange(iso, { startTime, endTime }) {
  const time = parseDate(iso, null);
  if (time === null) return false;
  if (startTime !== null && time < startTime) return false;
  if (endTime !== null && time > endTime) return false;
  return true;
}

function getCohortValue(profile, cohortBy, usersById) {
  if (cohortBy === 'advisor') return usersById.get(profile.advisorUserId) || 'unassigned';
  if (cohortBy === 'stage') return profile.stage || 'unassigned';
  if (cohortBy === 'sourceCity') return profile.source?.cityOrLocation || 'unknown';
  return profile.source?.venue || 'unknown';
}

function summarizeAnalytics({ profiles, submissions, notesByProfile, users, stageHistoryByProfile, filters }) {
  const usersById = new Map(users.map((user) => [user.id, `${user.firstName} ${user.lastName}`]));
  const prospects = profiles.filter((profile) => profile.kind === 'prospect');
  const cohortSegments = {};

  const filteredProspects = prospects.filter((profile) => {
    if (!inRange(profile.createdAt || profile.updatedAt, filters)) return false;
    const cohort = getCohortValue(profile, filters.cohortBy, usersById);
    if (filters.cohortValue && cohort !== filters.cohortValue) return false;
    cohortSegments[cohort] = (cohortSegments[cohort] || 0) + 1;
    return true;
  });

  const stageCounts = filteredProspects.reduce((acc, profile) => {
    const stage = profile.stage || 'unassigned';
    acc[stage] = (acc[stage] || 0) + 1;
    return acc;
  }, {});

  const topOfFunnel = stageCounts[STAGE_ORDER[0]] || 0;
  const funnel = STAGE_ORDER.map((stage, index) => {
    const count = stageCounts[stage] || 0;
    const previous = index === 0 ? count : (stageCounts[STAGE_ORDER[index - 1]] || 0);
    return {
      stage,
      count,
      conversionRate: topOfFunnel ? Number((count / topOfFunnel).toFixed(4)) : 0,
      stageToStageRate: previous ? Number((count / previous).toFixed(4)) : 0
    };
  });

  const now = Date.now();
  const stageAging = {};
  filteredProspects.forEach((profile) => {
    const stage = profile.stage || 'unassigned';
    const history = (stageHistoryByProfile.get(profile.id) || [])
      .filter((event) => (event.toStage || 'unassigned') === stage)
      .sort((a, b) => parseDate(a.changedAt, 0) - parseDate(b.changedAt, 0));
    const enteredAt = parseDate(history.at(-1)?.changedAt || profile.createdAt || profile.updatedAt, now) || now;
    const ageDays = Math.max(0, (now - enteredAt) / 86_400_000);
    stageAging[stage] ||= { values: [] };
    stageAging[stage].values.push(ageDays);
  });

  Object.entries(stageAging).forEach(([stage, bucket]) => {
    const sorted = bucket.values.slice().sort((a, b) => a - b);
    stageAging[stage] = {
      count: sorted.length,
      avgDays: avg(sorted),
      p50Days: percentile(sorted, 50),
      p90Days: percentile(sorted, 90),
      p95Days: percentile(sorted, 95)
    };
  });

  const filteredSubmissions = submissions.filter((submission) => inRange(submission.createdAt || submission.updatedAt, filters));
  const completionSla = {
    targetDays: filters.slaTargetDays,
    submittedWithinTarget: 0,
    submittedOutsideTarget: 0,
    draftOpenBeyondTarget: 0,
    completionRate: 0
  };
  const formCompletionRates = {};
  filteredSubmissions.forEach((submission) => {
    const key = submission.templateId || 'unknown';
    formCompletionRates[key] ||= { templateId: key, drafts: 0, submitted: 0, completionRate: 0 };
    const ageDays = Math.max(0, ((parseDate(submission.updatedAt, now) || now) - (parseDate(submission.createdAt, now) || now)) / 86_400_000);
    if (submission.status === 'submitted') {
      formCompletionRates[key].submitted += 1;
      if (ageDays <= filters.slaTargetDays) completionSla.submittedWithinTarget += 1;
      else completionSla.submittedOutsideTarget += 1;
    } else {
      formCompletionRates[key].drafts += 1;
      if (ageDays > filters.slaTargetDays) completionSla.draftOpenBeyondTarget += 1;
    }
  });
  Object.values(formCompletionRates).forEach((entry) => {
    const total = entry.drafts + entry.submitted;
    entry.completionRate = total ? Number((entry.submitted / total).toFixed(4)) : 0;
  });
  const totalSubmitted = completionSla.submittedWithinTarget + completionSla.submittedOutsideTarget;
  completionSla.completionRate = totalSubmitted ? Number((completionSla.submittedWithinTarget / totalSubmitted).toFixed(4)) : 0;

  const advisorThroughput = users
    .filter((user) => ['advisor', 'admin'].includes(user.role))
    .map((advisor) => {
      const advisorProfiles = filteredProspects.filter((profile) => profile.advisorUserId === advisor.id);
      const completed = advisorProfiles.filter((profile) => profile.stage === 'completed').length;
      const stageMoves = advisorProfiles.reduce((sum, profile) => sum + (stageHistoryByProfile.get(profile.id)?.length || 0), 0);
      const notesAuthored = advisorProfiles.reduce((sum, profile) => sum + (notesByProfile.get(profile.id)?.filter((note) => note.createdByUserId === advisor.id).length || 0), 0);
      const submissionsAuthored = filteredSubmissions.filter((submission) => submission.createdByUserId === advisor.id).length;
      const throughput = completed + stageMoves + notesAuthored + submissionsAuthored;
      return {
        advisorUserId: advisor.id,
        advisorName: `${advisor.firstName} ${advisor.lastName}`,
        assignedProspects: advisorProfiles.length,
        completedProspects: completed,
        stageMoves,
        notesAuthored,
        formSubmissionsAuthored: submissionsAuthored,
        throughput
      };
    })
    .sort((a, b) => b.throughput - a.throughput);

  const reconciliation = {
    sourceProspects: filteredProspects.length,
    aggregatedProspects: Object.values(stageCounts).reduce((sum, value) => sum + value, 0),
    sourceSubmissions: filteredSubmissions.length,
    aggregatedSubmissions: Object.values(formCompletionRates).reduce((sum, value) => sum + value.drafts + value.submitted, 0)
  };
  reconciliation.matches = reconciliation.sourceProspects === reconciliation.aggregatedProspects
    && reconciliation.sourceSubmissions === reconciliation.aggregatedSubmissions;

  const firstStage = stageCounts[STAGE_ORDER[0]] || 0;
  const completedStage = stageCounts.completed || 0;

  return {
    filters,
    stageCounts,
    funnel,
    cohortSegments,
    stageAging,
    completionSla,
    formCompletionRates: Object.values(formCompletionRates),
    advisorThroughput,
    overallConversionRate: firstStage ? Number((completedStage / firstStage).toFixed(4)) : 0,
    reconciliation,
    profileCount: profiles.length
  };
}

export function createAnalyticsService({ store, reads }) {
  function collect(user, rawFilters = {}) {
    const filters = parseFilters(rawFilters);
    const profiles = store.listProfiles(user);
    const submissions = store.listFormSubmissions(user);
    const users = store.listUsers(user);
    const notesByProfile = new Map(
      profiles.map((profile) => [profile.id, store.listNotes(user, profile.id)])
    );
    const stageHistoryByProfile = new Map(
      profiles.map((profile) => [profile.id, store.listStageHistory(user, profile.id)])
    );
    return summarizeAnalytics({ profiles, submissions, users, notesByProfile, stageHistoryByProfile, filters });
  }

  return {
    get(user, rawFilters = {}) {
      return {
        stageCounts: reads.getAnalytics(user.firmId),
        summary: collect(user, rawFilters),
        materialized: reads.getAnalyticsMaterialized(user.firmId)
      };
    },
    exportSnapshot(user, rawFilters = {}) {
      const summary = collect(user, rawFilters);
      return {
        fileName: `analytics-snapshot-${new Date().toISOString().slice(0, 10)}.json`,
        generatedAt: new Date().toISOString(),
        firmId: user.firmId,
        snapshot: summary
      };
export function createAnalyticsService({ analyticsRepository }) {
  return {
    get(user) {
      return {
        stageCounts: analyticsRepository.getStageCounts(user.firmId),
        summary: analyticsRepository.getSummary(user)
      };
    },
    getDiagnosticsContext(user) {
      return {
        auditEvents: analyticsRepository.listAuditEvents(user),
        exports: analyticsRepository.listExports(user)
      };
export function createAnalyticsService({ store, reads, policy }) {
  return {
    get(user) {
      policy.requireGuard(user, 'canReadAnalytics');
      return { stageCounts: reads.getAnalytics(user.firmId), summary: store.getAnalytics(user) };
    },
    getDiagnosticsContext(user) {
      policy.requireGuard(user, 'canReadDiagnostics');
      const auditEvents = store.listAudit(user);
      const exports = store.listExports(user);
      return { auditEvents, exports };
    }
  };
}
