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
import { Effect, Schema } from "effect";
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

const PolicyRead = Schema.Struct({
  tiers: Schema.NullOr(Schema.fromJsonString(RiskTiers)),
  risk: Schema.NullOr(RiskTier),
});

/**
 * The `ToolRiskPolicy` a host supplies for every executor call: the owner's policy and the tool's
 * override, read in one statement on each call so an edit applies to the next call. It also tells
 * the tool call log which tiers keep arguments. An owner other than an organization has none.
 */
export const makeToolRiskPolicy =
  (database: Effect.Effect<SqlClient.SqlClient, StorageError>) =>
  (target: { readonly owner: OwnerId; readonly app: AppId; readonly tool: ToolName }) =>
    Effect.gen(function* () {
      if (!target.owner.startsWith(organizationPrefix)) {
        yield* recordCallDetails({ recordsArguments: recordingOf(defaultRiskTiers) });
        return { actions: actionsOf(defaultRiskTiers) };
      }
      const organization = target.owner.slice(organizationPrefix.length);
      const sql = yield* database;
      const rows = yield* sql`select
          (select p.tiers::text from hosted_risk_policies p
            where p.organization_id = ${organization}) as tiers,
          (select o.risk from hosted_tool_risk_overrides o
            where o.organization_id = ${organization} and o.app_id = ${target.app}
              and o.tool = ${target.tool}) as risk`;
      const read = yield* Schema.decodeUnknownEffect(PolicyRead)(rows[0]);
      const tiers = read.tiers ?? defaultRiskTiers;
      yield* recordCallDetails({ recordsArguments: recordingOf(tiers) });
      return {
        actions: actionsOf(tiers),
        ...(read.risk === null ? {} : { tier: read.risk }),
      };
    }).pipe(
      Effect.catchTags({
        SqlError: () => new StorageError(),
        SchemaError: () => new StorageError(),
      }),
      Effect.withSpan("product.risk_policy.read"),
    );
