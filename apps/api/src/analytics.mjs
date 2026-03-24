const FUNNEL_STAGES = ['discovery', 'gather_oi', 'analysis', 'advisor_proposal_meeting', 'intake', 'on_boarding', 'investment_strategy', 'completed'];
const TERMINAL_STAGES = new Set(['completed', 'drop_dead_lead', 'drop_nurture']);

function toDayMs(isoDate) {
  return new Date(isoDate).getTime();
}

function round(value, digits = 1) {
  const base = 10 ** digits;
  return Math.round(value * base) / base;
}

function percent(numerator, denominator) {
  if (!denominator) return 0;
  return round((numerator / denominator) * 100, 1);
}

function computeFunnel(prospects) {
  const stageCounts = Object.fromEntries(FUNNEL_STAGES.map((stage) => [stage, 0]));
  let dropped = 0;

  for (const prospect of prospects) {
    const stage = prospect.stage || 'discovery';
    if (stage in stageCounts) {
      stageCounts[stage] += 1;
    } else if (stage === 'drop_dead_lead' || stage === 'drop_nurture') {
      dropped += 1;
    }
  }

  const entered = prospects.length;
  const completed = stageCounts.completed || 0;
  const byStage = FUNNEL_STAGES.map((stage, index) => {
    if (index === FUNNEL_STAGES.length - 1) {
      return {
        stage,
        count: stageCounts[stage],
        conversionFromPreviousPct: 100
      };
    }

    const nextStage = FUNNEL_STAGES[index + 1];
    return {
      stage,
      count: stageCounts[stage],
      nextStage,
      conversionToNextPct: percent(stageCounts[nextStage], stageCounts[stage])
    };
  });

  return {
    entered,
    completed,
    dropped,
    completionRatePct: percent(completed, entered),
    dropOffRatePct: percent(dropped, entered),
    byStage
  };
}

function computeStageAging(prospects, stageChanges, referenceTime) {
  const nowMs = toDayMs(referenceTime);
  const stageByClient = new Map();

  for (const change of stageChanges) {
    const existing = stageByClient.get(change.clientId);
    const changeMs = toDayMs(change.changedAt);
    if (!existing || changeMs > existing.changedAtMs) {
      stageByClient.set(change.clientId, { stage: change.toStage, changedAtMs: changeMs, changedAt: change.changedAt });
    }
  }

  const grouped = new Map();
  for (const prospect of prospects) {
    const activeStage = prospect.stage || 'discovery';
    const latestChange = stageByClient.get(prospect.id);
    const enteredAt = latestChange?.stage === activeStage ? latestChange.changedAt : (prospect.updatedAt || prospect.createdAt);
    const ageDays = Math.max(0, round((nowMs - toDayMs(enteredAt)) / (1000 * 60 * 60 * 24), 1));

    if (!grouped.has(activeStage)) {
      grouped.set(activeStage, []);
    }
    grouped.get(activeStage).push({ prospectId: prospect.id, ageDays, enteredAt });
  }

  const perStage = [...grouped.entries()]
    .map(([stage, entries]) => {
      const totalAge = entries.reduce((sum, entry) => sum + entry.ageDays, 0);
      const oldest = entries.slice().sort((left, right) => right.ageDays - left.ageDays)[0];
      return {
        stage,
        prospectCount: entries.length,
        averageAgeDays: round(totalAge / entries.length, 1),
        oldestAgeDays: oldest.ageDays,
        oldestProspectId: oldest.prospectId
      };
    })
    .sort((left, right) => right.averageAgeDays - left.averageAgeDays);

  const overallAverageAgeDays = perStage.length
    ? round(perStage.reduce((sum, stage) => sum + (stage.averageAgeDays * stage.prospectCount), 0) / prospects.length, 1)
    : 0;

  return { overallAverageAgeDays, perStage };
}

function computeBottlenecks(stageAging) {
  const stages = stageAging.perStage
    .filter((stage) => !TERMINAL_STAGES.has(stage.stage) && stage.prospectCount > 0)
    .sort((left, right) => right.averageAgeDays - left.averageAgeDays)
    .slice(0, 3)
    .map((stage) => ({
      stage: stage.stage,
      prospectCount: stage.prospectCount,
      averageAgeDays: stage.averageAgeDays,
      oldestAgeDays: stage.oldestAgeDays,
      severity: stage.averageAgeDays >= 14 ? 'high' : stage.averageAgeDays >= 7 ? 'medium' : 'low'
    }));

  return {
    count: stages.length,
    stages
  };
}

function computeFormCompletion(formSubmissions) {
  const totals = { draft: 0, submitted: 0 };
  const templateStats = new Map();

  for (const submission of formSubmissions) {
    const status = submission.status === 'draft' ? 'draft' : 'submitted';
    totals[status] += 1;

    if (!templateStats.has(submission.templateId)) {
      templateStats.set(submission.templateId, { templateId: submission.templateId, draft: 0, submitted: 0 });
    }
    templateStats.get(submission.templateId)[status] += 1;
  }

  const total = totals.draft + totals.submitted;
  return {
    draftCount: totals.draft,
    submittedCount: totals.submitted,
    completionRatePct: percent(totals.submitted, total),
    byTemplate: [...templateStats.values()]
      .map((entry) => ({
        templateId: entry.templateId,
        draftCount: entry.draft,
        submittedCount: entry.submitted,
        completionRatePct: percent(entry.submitted, entry.draft + entry.submitted)
      }))
      .sort((left, right) => right.submittedCount - left.submittedCount)
  };
}

function computeExportUsage(exportJobs, auditEvents) {
  const byType = exportJobs.reduce((acc, job) => {
    acc[job.type] = (acc[job.type] || 0) + 1;
    return acc;
  }, {});
  const completed = exportJobs.filter((job) => job.status === 'completed').length;
  const queued = exportJobs.filter((job) => job.status === 'queued').length;
  const retried = auditEvents.filter((event) => event.action === 'export_job.retried').length;

  return {
    totalExports: exportJobs.length,
    completedExports: completed,
    queuedExports: queued,
    completionRatePct: percent(completed, exportJobs.length),
    retryCount: retried,
    byType
  };
}

function computeAdvisorActivity(users, auditEvents, referenceTime) {
  const cutoffMs = toDayMs(referenceTime) - (1000 * 60 * 60 * 24 * 30);
  const eventsByAdvisor = new Map();

  for (const user of users) {
    eventsByAdvisor.set(user.id, {
      userId: user.id,
      advisor: `${user.firstName} ${user.lastName}`,
      role: user.role,
      totalEvents: 0,
      last30DaysEvents: 0,
      lastActivityAt: null
    });
  }

  for (const event of auditEvents) {
    const bucket = eventsByAdvisor.get(event.actorUserId);
    if (!bucket) continue;
    bucket.totalEvents += 1;
    const eventMs = toDayMs(event.occurredAt);
    if (eventMs >= cutoffMs) {
      bucket.last30DaysEvents += 1;
    }
    if (!bucket.lastActivityAt || eventMs > toDayMs(bucket.lastActivityAt)) {
      bucket.lastActivityAt = event.occurredAt;
    }
  }

  const advisors = [...eventsByAdvisor.values()].sort((left, right) => right.totalEvents - left.totalEvents);
  return {
    totalActiveAdvisors: advisors.filter((advisor) => advisor.totalEvents > 0).length,
    advisors
  };
}

export function buildAnalyticsSummary({ prospects, profiles, households, documentTemplates, formSubmissions, exportJobs, stageChanges, auditEvents, users, nowIso = new Date().toISOString() }) {
  const funnel = computeFunnel(prospects);
  const stageAging = computeStageAging(prospects, stageChanges, nowIso);

  return {
    stageCounts: prospects.reduce((acc, profile) => {
      acc[profile.stage || 'unassigned'] = (acc[profile.stage || 'unassigned'] || 0) + 1;
      return acc;
    }, {}),
    profileCount: profiles.length,
    householdCount: households.length,
    exportCount: exportJobs.length,
    templateCount: documentTemplates.length,
    funnel,
    stageAging,
    bottlenecks: computeBottlenecks(stageAging),
    formCompletion: computeFormCompletion(formSubmissions),
    exportUsage: computeExportUsage(exportJobs, auditEvents),
    advisorActivity: computeAdvisorActivity(users, auditEvents, nowIso)
  };
}
