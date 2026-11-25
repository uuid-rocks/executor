/** Tool-owned approval policies, evaluated after native input decoding. */
import { Schema, type Effect } from "effect";
// JHPATCH: risk tiers are declared beside approvals.
import type { RiskTier } from "./protocols/current.ts";

/** Approve this call, deny it, or stop for a human decision. */
export const ApprovalDecision = Schema.Literals(["approved", "denied", "user-approval"]);
/** Parsed result of one tool approval policy. */
export type ApprovalDecision = typeof ApprovalDecision.Type;

/** Context for one tool's policy. toolInput is the same decoded value passed to run. */
export interface ApprovalContext<Input = unknown> {
  readonly toolName: string;
  readonly toolInput: Input;
  readonly signal: AbortSignal;
}

/** Native policy for this tool only. Failures prevent execution and remain private. */
export type Approval<Input = unknown> = (
  context: ApprovalContext<Input>,
) => Effect.Effect<ApprovalDecision, unknown>;

// JHPATCH: a tool's risk tier, fixed or chosen from each call's input; organizations act on it.
/**
 * A tool's risk tier, or a function that chooses one from each call's decoded input. Failures
 * prevent execution and remain private.
 */
export type Risk<Input = unknown> =
  | RiskTier
  | ((context: ApprovalContext<Input>) => Effect.Effect<RiskTier, unknown>);
