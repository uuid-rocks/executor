/** Effect-only host lifecycle. These privileged operations are not mounted on the SDK HTTP API. */
import { Context, Effect } from "effect";
// JHPATCH: the types a scheduled run's tool calls are described with.
import type { ScheduledRun, ScheduledRunId, ScheduleId } from "./schedules.ts";
import type { AppId, ApprovalRequestId, Json, OwnerId, StorageError, ToolName } from "./shared.ts";
import type { AppAccounts } from "./apps.ts";
import type { ToolCallResult, ToolKind, ToolResumeResult } from "./tools.ts";

/** Authorize the saved actor against current product membership and app/account access before every dispatch. */
export interface ScheduleAuthority {
  readonly app: AppId;
  readonly owner: OwnerId;
  /** The schedule's actor; null for an app schedule, which an app manager enabled for the app. */
  readonly actor: string | null;
  readonly phase: "start" | "resume";
}
/** A host owns the named runner for its whole lifetime. Recovery requires the old runner to have stopped. */
export interface ScheduleDispatcher {
  readonly tick: (options: {
    readonly runner: string;
    readonly maxCandidates: number;
    readonly authorize: (target: ScheduleAuthority) => Effect.Effect<void, Error>;
    /** Host-owned admission gate. Skip the effect when full, leaving the occurrence unclaimed for the next wake. */
    readonly execute: (
      operation: Effect.Effect<void, StorageError>,
    ) => Effect.Effect<void, StorageError>;
  }) => Effect.Effect<void, StorageError>;
  readonly recover: (runner: string) => Effect.Effect<void, StorageError>;
  readonly nextWake: Effect.Effect<Date | null, StorageError>;
}

/** Optional host observer runs after a terminal transition commits, without payloads or credentials. */
export const ScheduleObservation = Context.Reference<{
  readonly completed: (
    run: Pick<
      ScheduledRun,
      "id" | "scheduleId" | "app" | "owner" | "status" | "startedAt" | "finishedAt"
    >,
  ) => Effect.Effect<void>;
}>("executor/ScheduleObservation", { defaultValue: () => ({ completed: () => Effect.void }) });

// JHPATCH: hosts log the tool calls scheduled runs make, as they log their callers' calls.
/** The scheduled run a tool call or resume belongs to, as {@link ScheduledToolCalls} is told. */
export interface ScheduledCall {
  readonly owner: OwnerId;
  readonly app: AppId;
  /** The member the run acts for; null for an app schedule. */
  readonly actor: string | null;
  readonly schedule: { readonly id: ScheduleId; readonly name: string };
  readonly run: ScheduledRunId;
}
/** The tool call a scheduled run makes. */
export interface ScheduledToolCall {
  readonly tool: ToolName;
  readonly kind: ToolKind;
  readonly input: Json;
  readonly accounts: AppAccounts;
}
/**
 * Host-only: wraps each tool call a scheduled run makes, and each resume of a call that paused for
 * approval, so the host can record them. Each must return `work`'s outcome unchanged.
 */
export interface ScheduledToolCallHooks {
  readonly call: <E, R>(
    run: ScheduledCall,
    call: ScheduledToolCall,
    work: Effect.Effect<ToolCallResult, E, R>,
  ) => Effect.Effect<ToolCallResult, E, R>;
  readonly resume: <E, R>(
    run: ScheduledCall,
    requestId: ApprovalRequestId,
    work: Effect.Effect<ToolResumeResult, E, R>,
  ) => Effect.Effect<ToolResumeResult, E, R>;
}
export const ScheduledToolCalls = Context.Reference<ScheduledToolCallHooks | undefined>(
  "executor/ScheduledToolCalls",
  { defaultValue: () => undefined },
);
