// ABOUTME: Classifies bounded runtime observations without granting capabilities from process presence.
// ABOUTME: Keeps native delivery and full permission isolation unverified until their adapter gates pass.

export function classifyCapabilities(cases) {
  const initial = cases.fresh;
  return {
    fresh:
      initial?.completed && initial.reply_confirmed && initial.session_id
        ? "supported"
        : "unverified",
    exact_resume:
      initial?.session_id &&
      cases.resume?.completed &&
      cases.resume.session_id === initial.session_id &&
      cases.resume.remembered_marker
        ? "supported"
        : "unverified",
    fork:
      initial?.session_id &&
      cases.fork?.completed &&
      cases.fork.session_id &&
      cases.fork.session_id !== initial.session_id &&
      cases.fork.remembered_marker
        ? "supported"
        : "unverified",
    read_only: "unverified",
    wrong_session_rejection:
      cases.wrong_session &&
      !cases.wrong_session.started &&
      Number.isInteger(cases.wrong_session.code) &&
      cases.wrong_session.code > 0 &&
      !cases.wrong_session.timed_out &&
      !cases.wrong_session.process_lost
        ? "supported"
        : "unverified",
    interrupt:
      cases.interrupt?.interrupted &&
      cases.interrupt.turn_observed &&
      !cases.interrupt.completed &&
      !cases.interrupt.escalated &&
      !cases.interrupt.timed_out &&
      !cases.interrupt.process_lost
        ? "supported"
        : "unverified",
    native_external_idle: "unverified",
    native_external_active: "unverified",
    native_duplicate_suppression:
      cases.duplicate_first?.completed && cases.duplicate_second?.completed
        ? "unsupported"
        : "unverified",
    native_busy_session_rejection: cases.busy_contender?.overlapping_identity
      ? "unsupported"
      : cases.busy_contender?.active_writer_rejected &&
          !cases.busy_contender.started &&
          Number.isInteger(cases.busy_contender.code) &&
          cases.busy_contender.code > 0
        ? "supported"
        : "unverified",
  };
}
