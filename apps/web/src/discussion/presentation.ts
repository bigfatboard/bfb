// ABOUTME: Pure D03 presentation rules for eligibility, speaker, delivery, and deadline.
// ABOUTME: Every blocking condition maps to an actionable state; prose never implies completion.

import type {
  AgentProfileRecord,
  DiscussionMessageSummary,
  DiscussionView,
} from "./api.js";

export type Eligibility =
  | "eligible"
  | "busy"
  | "offline"
  | "revoked"
  | "unsupported"
  | "checkout_conflict";

export interface EligibilityResult {
  status: Eligibility;
  headline: string;
  nextAction: string;
}

export interface RunnerInput {
  runner_id: string;
  device_label: string;
  status: "enrolled" | "revoked";
  launcher_human_ids: string[];
  owner_human_id: string;
}

export interface CheckoutInput {
  checkout_id: string;
  runner_id: string;
  project_id: string;
  label: string;
  status: "registered" | "validated" | "stale" | "blocked";
  block_reason?: string;
  inventory_valid: boolean;
}

export interface ProfileEligibilityInput {
  profile: AgentProfileRecord;
  runner: RunnerInput | undefined;
  checkout: CheckoutInput | undefined;
  checkoutOccupied: boolean;
  humanId: string;
}

/**
 * Eligibility for one discussion participant slot. The ordering is deliberate:
 * revoked authority first, then reachability, then provider support, then
 * checkout conflicts. An eligible slot is never a claim that delivery will succeed.
 */
export function describeSlotEligibility(input: ProfileEligibilityInput): EligibilityResult {
  if (!input.runner || input.runner.status === "revoked") {
    return {
      status: "revoked",
      headline: "Runner revoked",
      nextAction: "Only the owner can re-enroll this Mac from the device. Pick another runner.",
    };
  }
  if (
    input.runner.owner_human_id !== input.humanId &&
    !input.runner.launcher_human_ids.includes(input.humanId)
  ) {
    return {
      status: "revoked",
      headline: "No launch grant",
      nextAction: "Ask the runner owner for a launch grant, or pick a runner you may use.",
    };
  }
  if (!input.checkout || !input.checkout.inventory_valid) {
    return {
      status: "offline",
      headline: "Runner offline",
      nextAction: "The Mac has not reported inventory. Wake it or pick a reporting runner.",
    };
  }
  if (
    input.profile.provider !== "claude" &&
    input.profile.provider !== "codex"
  ) {
    return {
      status: "unsupported",
      headline: "Unsupported provider",
      nextAction: "Discussions need a restricted headless Claude or Codex profile.",
    };
  }
  if (
    input.profile.execution_mode !== "headless" ||
    input.profile.harness_mode !== "restricted"
  ) {
    return {
      status: "unsupported",
      headline: "Profile cannot hold a read-only discussion",
      nextAction: "Pick a restricted headless profile. Interactive or standard profiles are rejected.",
    };
  }
  if (!input.checkout || input.checkout.status !== "validated" || input.checkout.block_reason) {
    return {
      status: "checkout_conflict",
      headline: "Checkout unavailable",
      nextAction: "Pick a validated checkout for this project. Stale, blocked, or mismatched checkouts are rejected.",
    };
  }
  if (input.checkoutOccupied) {
    return {
      status: "busy",
      headline: "Checkout busy",
      nextAction: "Another participant holds this worktree. Pick a different checkout or wait.",
    };
  }
  return {
    status: "eligible",
    headline: "Eligible",
    nextAction: "This slot may start a discussion. Delivery still reauthorizes every turn.",
  };
}

export function canStartDiscussion(first: EligibilityResult, second: EligibilityResult): boolean {
  return first.status === "eligible" && second.status === "eligible";
}

export interface Speaker {
  ordinal: number;
  round: number;
  participantId: string;
  participantName: string;
  provider: string;
}

/** Current speaker is the lowest-ordinal turn that is planned or active. Null when no turn is open. */
export function currentSpeaker(view: DiscussionView): Speaker | null {
  const open = view.turns
    .filter((turn) => turn.state === "planned" || turn.state === "active")
    .sort((left, right) => left.ordinal - right.ordinal)[0];
  if (!open) {
    return null;
  }
  const participant = view.participants.find((entry) => entry.id === open.participant_id);
  return {
    ordinal: open.ordinal,
    round: Math.floor((open.ordinal - 1) / 2) + 1,
    participantId: open.participant_id,
    participantName: participant?.name ?? "Unknown participant",
    provider: participant?.provider ?? "unknown",
  };
}

export function totalRounds(view: DiscussionView): number {
  return Math.max(1, Math.floor(view.turns.length / 2));
}

export function completedTurns(view: DiscussionView): number {
  return view.turns.filter((turn) => turn.state === "completed").length;
}

export type DeliveryTone = "waiting" | "active" | "settled" | "blocked";

export interface DeliveryPresentation {
  headline: string;
  detail: string;
  tone: DeliveryTone;
}

/** Delivery states render from committed records only. Queued is not working. */
export function describeDelivery(
  state:
    | "accepted"
    | "dispatched"
    | "acknowledged"
    | "completed"
    | "ambiguous"
    | "failed",
): DeliveryPresentation {
  switch (state) {
    case "accepted":
      return {
        headline: "Queued",
        detail: "The turn is accepted and waits for supervised dispatch. Nothing has run.",
        tone: "waiting",
      };
    case "dispatched":
      return {
        headline: "Dispatched",
        detail: "The Mac started the owned session turn. Acknowledgement is still pending.",
        tone: "active",
      };
    case "acknowledged":
      return {
        headline: "Acknowledged",
        detail: "The exact owned session acknowledged the turn. The bounded output is pending.",
        tone: "active",
      };
    case "completed":
      return {
        headline: "Completed",
        detail: "The bounded recommendation is committed below.",
        tone: "settled",
      };
    case "ambiguous":
      return {
        headline: "Ambiguous delivery",
        detail:
          "The Mac cannot prove whether the provider acted. The schedule paused; nothing was resent.",
        tone: "blocked",
      };
    case "failed":
      return {
        headline: "Delivery failed",
        detail: "The turn failed visibly. The correlated history is retained above.",
        tone: "blocked",
      };
  }
}

export interface StopPresentation {
  headline: string;
  detail: string;
  stopped: boolean;
}

/** Terminal discussion state. Cancel and deadline prevent further dispatch. */
export function describeStop(view: DiscussionView): StopPresentation {
  switch (view.state) {
    case "cancelled":
      return {
        headline: "Cancelled by the human",
        detail: "No later turn is accepted. Committed recommendations stay inspectable.",
        stopped: true,
      };
    case "failed":
      return {
        headline: view.reason === "deadline_exceeded" ? "Deadline exceeded" : "Discussion failed",
        detail:
          view.reason === "delivery_ambiguous"
            ? "Recovery uncertainty remains visible. Nothing was blindly resent."
            : "No later turn is accepted. Committed recommendations stay inspectable.",
        stopped: true,
      };
    case "concluded":
      return {
        headline: "Concluded",
        detail: "Every bounded turn completed. The final recommendations are frozen below.",
        stopped: true,
      };
    case "paused":
      return {
        headline: "Paused",
        detail: "Delivery paused on uncertainty. Resolve the ambiguous turn before continuing.",
        stopped: true,
      };
    case "active":
      if (view.dispatch_block_reason === "deadline_exceeded") {
        return {
          headline: "Deadline exceeded",
          detail: "The deadline passed. No new turn is dispatched.",
          stopped: true,
        };
      }
      return {
        headline: "Active",
        detail: "Turns dispatch while the deadline, authorization, and bounds hold.",
        stopped: false,
      };
  }
}

export interface DeadlinePresentation {
  headline: string;
  expired: boolean;
}

/** Deadline renders from the committed value against the supplied clock. */
export function describeDeadline(deadlineIso: string, nowMs: number): DeadlinePresentation {
  const deadlineMs = Date.parse(deadlineIso);
  if (!Number.isFinite(deadlineMs)) {
    return { headline: "Deadline unknown", expired: false };
  }
  const remainingMs = deadlineMs - nowMs;
  if (remainingMs <= 0) {
    return { headline: "Deadline exceeded", expired: true };
  }
  const minutes = Math.floor(remainingMs / 60_000);
  const seconds = Math.floor((remainingMs % 60_000) / 1000);
  if (minutes <= 0) {
    return { headline: `Deadline in ${seconds}s`, expired: false };
  }
  return { headline: `Deadline in ${minutes}m ${seconds}s`, expired: false };
}

export interface PositionSummary {
  messageId: string;
  participantName: string;
  provider: string;
  recommendation: string;
}

/** Independent initial positions are the committed ordinal 1 and 2 recommendations. */
export function independentPositions(view: DiscussionView): PositionSummary[] {
  const byTurn = new Map(view.turns.map((turn) => [turn.id, turn]));
  return view.messages
    .filter((message) => message.kind === "recommendation" && message.output)
    .filter((message) => {
      const turn = message.turn_id ? byTurn.get(message.turn_id) : undefined;
      return turn !== undefined && turn.ordinal <= 2;
    })
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
    .map((message) => {
      const participant = view.participants.find((entry) => entry.id === message.participant_id);
      return {
        messageId: message.id,
        participantName: participant?.name ?? "Unknown participant",
        provider: participant?.provider ?? "unknown",
        recommendation: message.output?.recommendation ?? "",
      };
    });
}

export interface DisagreementSummary {
  fromMessageId: string;
  fromParticipantName: string;
  targetMessageId: string;
  targetParticipantName: string;
  reason: string;
}

/** Disagreements stay inspectable with both ends attributed. */
export function openDisagreements(view: DiscussionView): DisagreementSummary[] {
  const byMessage = new Map(view.messages.map((message) => [message.id, message]));
  const nameOf = (message: DiscussionMessageSummary | undefined): string => {
    if (!message) {
      return "Unknown message";
    }
    if (message.kind === "intervention") {
      return "Human intervention";
    }
    return view.participants.find((entry) => entry.id === message.participant_id)?.name ?? "Unknown participant";
  };
  const out: DisagreementSummary[] = [];
  for (const message of view.messages) {
    if (message.kind !== "recommendation" || !message.output) {
      continue;
    }
    for (const disagreement of message.output.disagreements) {
      out.push({
        fromMessageId: message.id,
        fromParticipantName: nameOf(message),
        targetMessageId: disagreement.message_id,
        targetParticipantName: nameOf(byMessage.get(disagreement.message_id)),
        reason: disagreement.reason,
      });
    }
  }
  return out;
}

export function humanQuestions(view: DiscussionView): { messageId: string; question: string }[] {
  const out: { messageId: string; question: string }[] = [];
  for (const message of view.messages) {
    if (message.kind !== "recommendation" || !message.output) {
      continue;
    }
    for (const question of message.output.human_questions) {
      out.push({ messageId: message.id, question });
    }
  }
  return out;
}

/** A human decision is distinct from an agent recommendation and never completes the task. */
export function decisionSummary(view: DiscussionView): string | null {
  if (!view.decision) {
    return null;
  }
  const kind =
    view.decision.kind === "record_recommendation"
      ? "Recorded recommendation"
      : view.decision.kind === "decline"
        ? "Declined"
        : "Needs more context";
  return `${kind}: ${view.decision.summary}`;
}

export function participantName(
  view: DiscussionView,
  participantId: string | undefined,
): string {
  if (!participantId) {
    return "Unknown participant";
  }
  return view.participants.find((entry) => entry.id === participantId)?.name ?? "Unknown participant";
}
