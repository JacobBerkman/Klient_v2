// Per-profile meetings service. Thin policy-guarded wrapper over the store
// (same shape as the pipeline service). Meetings are per-profile advisory
// activity, so they reuse the profile guards: canReadProfiles for the list,
// canWriteProfiles for create/delete. The store re-checks profiles:read/write
// and firm-scopes the parent profile as defense in depth.
export function createMeetingsService({ store, policy }) {
  return {
    listMeetings(user, profileId) {
      policy.requireGuard(user, 'canReadProfiles')
      return store.listMeetings(user, profileId)
    },
    createMeeting(user, profileId, input) {
      policy.requireGuard(user, 'canWriteProfiles')
      return store.createMeeting(user, profileId, input)
    },
    deleteMeeting(user, profileId, meetingId) {
      policy.requireGuard(user, 'canWriteProfiles')
      return store.deleteMeeting(user, profileId, meetingId)
    },
    listUpcoming(user, options = {}) {
      policy.requireGuard(user, 'canReadProfiles')
      return store.listUpcomingMeetings(user, options)
    }
  }
}
