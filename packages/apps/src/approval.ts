/** Tool approval author API; no state or execution starts during declaration. */
import type { Effect } from "effect";
import type { Approval as NativeApproval } from "./contracts/approval.ts";
export type { ApprovalContext, ApprovalDecision } from "./contracts/approval.ts";
// JHPATCH: risk tiers, declared beside approvals.
import type { ApprovalContext } from "./contracts/approval.ts";
import type { RiskTier } from "./contracts/protocols/current.ts";
export type { RiskTier } from "./contracts/protocols/current.ts";

/** Synchronous or async policy, projected from the framework's native contract. */
export type Approval<Input = unknown> = (
  ...args: Parameters<NativeApproval<Input>>
) =>
  | Effect.Success<ReturnType<NativeApproval<Input>>>
  | Promise<Effect.Success<ReturnType<NativeApproval<Input>>>>;

/** Require human approval for every call to the tool. */
export const always =
  <Input = unknown>(): Approval<Input> =>
  () =>
    "user-approval";

/** Never require human approval for this tool. Product access checks still apply. */
export const never =
  <Input = unknown>(): Approval<Input> =>
  () =>
    "approved";

// JHPATCH: a tool's risk tier, fixed or chosen from each call's input.
/**
 * How risky a call is: `low` reads or changes nothing that matters, `medium` is an ordinary write,
 * `high` is hard to undo, such as a delete, and `critical` changes production, moves money or acts
 * in bulk. A function chooses the tier from each call's decoded input, synchronously or async.
 * The organization's risk policy decides what each tier does: keep the app's approval, always ask
 * a person, or block the call.
 */
export type Risk<Input = unknown> =
  | RiskTier
  | ((context: ApprovalContext<Input>) => RiskTier | Promise<RiskTier>);
