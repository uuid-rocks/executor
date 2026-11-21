// JHPATCH: every hosted tool call reads its organization's risk policy.
/**
 * The `ToolRiskPolicy` hosts supply. Kept apart from the policy's API so Workers that only serve
 * tool calls bundle no route code for it.
 */
import {
  RiskTier,
  StorageError,
  type AppId,
  type OwnerId,
  type RiskActions,
  type ToolName,
} from "@executor-js/sdk/core";
import { Context, Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { defaultRiskTiers, RiskTiers, type RiskTiers as Tiers } from "../contracts/risk-policy.ts";
import { recordCallDetails } from "./tool-call-log.ts";

const organizationPrefix = "organization:";

const actionsOf = (tiers: Tiers): RiskActions => ({
  low: tiers.low.approval,
  medium: tiers.medium.approval,
  high: tiers.high.approval,
  critical: tiers.critical.approval,
});
const recordingOf = (tiers: Tiers) => ({
  low: tiers.low.recordArguments,
  medium: tiers.medium.recordArguments,
  high: tiers.high.recordArguments,
  critical: tiers.critical.recordArguments,
});

/** Which call's policy {@link riskPolicyColumns} reads. */
export interface RiskPolicyTarget {
  readonly organization: string;
  readonly app: AppId;
  readonly tool: ToolName;
}
/**
 * The organization's policy and the tool's override, as two columns of a select: one indexed read
 * each, so the access check a call already makes can carry them in its own statement.
 */
export const riskPolicyColumns = (sql: SqlClient.SqlClient, target: RiskPolicyTarget) =>
  sql`(select rp.tiers::text from hosted_risk_policies rp
      where rp.organization_id = ${target.organization}) as "riskTiers",
    (select ro.risk from hosted_tool_risk_overrides ro
      where ro.organization_id = ${target.organization} and ro.app_id = ${target.app}
        and ro.tool = ${target.tool}) as "riskOverride"`;
/** The raw {@link riskPolicyColumns}, decoded only by the call that uses them. */
export const RiskPolicyColumns = Schema.Struct({
  riskTiers: Schema.NullOr(Schema.String),
  riskOverride: Schema.NullOr(Schema.String),
});
/** {@link riskPolicyColumns} as one call's access check read them, and for which call. */
export interface RiskPolicyRead extends RiskPolicyTarget {
  readonly columns: typeof RiskPolicyColumns.Type;
}
/**
 * The policy a tool call's access check read in its own statement, for the call it is about to
 * make. `ToolRiskPolicy` uses it once, for that organization, app and tool; any other read is live.
 */
export const RiskPolicyReadAhead = Context.Reference<RiskPolicyRead | undefined>(
  "hosted/RiskPolicyReadAhead",
  { defaultValue: () => undefined },
);

const PolicyRead = Schema.Struct({
  riskTiers: Schema.NullOr(Schema.fromJsonString(RiskTiers)),
  riskOverride: Schema.NullOr(RiskTier),
});

/**
 * The `ToolRiskPolicy` a host supplies for every executor call: the owner's policy and the tool's
 * override, read on each call so an edit applies to the next call. A call whose access check read
 * them ({@link RiskPolicyReadAhead}) uses that read; others, such as resumes and schedules, read
 * them in one statement. It also tells the tool call log which tiers keep arguments. An owner
 * other than an organization has none.
 */
export const makeToolRiskPolicy = (database: Effect.Effect<SqlClient.SqlClient, StorageError>) => {
  // A read made ahead answers one call: a later call in the same scope reads live.
  const consumed = new WeakSet<RiskPolicyRead>();
  return (target: { readonly owner: OwnerId; readonly app: AppId; readonly tool: ToolName }) =>
    Effect.gen(function* () {
      if (!target.owner.startsWith(organizationPrefix)) {
        yield* recordCallDetails({ recordsArguments: recordingOf(defaultRiskTiers) });
        return { actions: actionsOf(defaultRiskTiers) };
      }
      const organization = target.owner.slice(organizationPrefix.length);
      const ahead = yield* RiskPolicyReadAhead;
      let columns: unknown;
      if (
        ahead !== undefined &&
        !consumed.has(ahead) &&
        ahead.organization === organization &&
        ahead.app === target.app &&
        ahead.tool === target.tool
      ) {
        consumed.add(ahead);
        columns = ahead.columns;
      } else {
        const sql = yield* database;
        const rows = yield* sql`select ${riskPolicyColumns(sql, { ...target, organization })}`;
        columns = rows[0];
      }
      const read = yield* Schema.decodeUnknownEffect(PolicyRead)(columns);
      const tiers = read.riskTiers ?? defaultRiskTiers;
      yield* recordCallDetails({ recordsArguments: recordingOf(tiers) });
      return {
        actions: actionsOf(tiers),
        ...(read.riskOverride === null ? {} : { tier: read.riskOverride }),
      };
    }).pipe(
      Effect.catchTags({
        SqlError: () => new StorageError(),
        SchemaError: () => new StorageError(),
      }),
      Effect.withSpan("product.risk_policy.read"),
    );
};
