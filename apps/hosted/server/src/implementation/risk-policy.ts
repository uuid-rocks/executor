// JHPATCH: organizations decide what each tool risk tier does and may override a tool's tier.
/**
 * The organization's risk policy: read by every tool call through `ToolRiskPolicy`, shown to every
 * member and edited by owners and admins. An organization with no saved policy uses
 * `defaultRiskTiers`.
 */
import { AppId, AppNotFound, RiskTier, StorageError, ToolName } from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HostedApi } from "../contracts/api.ts";
import { OrganizationForbidden } from "../contracts/organization.ts";
import { AccessConflict } from "../contracts/resource-access.ts";
import {
  defaultRiskTiers,
  RiskTiers,
  type RiskPolicy,
  type RiskTiers as Tiers,
} from "../contracts/risk-policy.ts";
import {
  applicationAccesses,
  currentResourceAuthority,
  policyDatabase,
  type ResourceAuthority,
} from "./resource-policy.ts";
import { audited } from "./security-audit.ts";

/** The revision of an organization with no saved policy; a saved one's is a random UUID. */
const defaultRevision = "default";
/** The most characters of a name the policy copies. */
const nameLength = 200;
const Person = { id: Schema.NullOr(Schema.String), name: Schema.NullOr(Schema.String) };
const PolicyRow = Schema.Struct({
  tiers: Schema.fromJsonString(RiskTiers),
  revision: Schema.String,
  updated_ms: Schema.Number,
  updated_by: Person.id,
  updated_by_name: Person.name,
});
const OverrideRow = Schema.Struct({
  app_id: AppId,
  app_name: Schema.NullOr(Schema.String),
  tool: ToolName,
  risk: RiskTier,
  set_by: Person.id,
  set_by_name: Person.name,
  set_ms: Schema.Number,
});
const person = (id: string | null, name: string | null) =>
  id === null && name === null ? null : { id, name };

/** The policy as `actor` may read it: members see only overrides of apps they may use. */
const readPolicy = (actor: ResourceAuthority) =>
  Effect.gen(function* () {
    const sql = yield* policyDatabase;
    const saved = yield* sql`select tiers::text as tiers, revision,
        (extract(epoch from updated_at) * 1000)::float8 as updated_ms, updated_by, updated_by_name
      from hosted_risk_policies where organization_id = ${actor.organization}`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(PolicyRow))),
    );
    const overrides = yield* sql`select o.app_id, a.name as app_name, o.tool, o.risk, o.set_by,
        o.set_by_name, (extract(epoch from o.set_at) * 1000)::float8 as set_ms
      from hosted_tool_risk_overrides o left join executor_apps a on a.id = o.app_id
      where o.organization_id = ${actor.organization}
      order by lower(a.name), o.app_id, o.tool`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(OverrideRow))),
    );
    const usable =
      actor.role === "member"
        ? new Set(
            (yield* applicationAccesses([...new Set(overrides.map((row) => row.app_id))], actor))
              .filter((access) => access.canUse)
              .map((access) => access.app),
          )
        : undefined;
    const policy = saved[0];
    const result: RiskPolicy = {
      tiers: policy?.tiers ?? defaultRiskTiers,
      revision: policy?.revision ?? defaultRevision,
      updatedAt: policy === undefined ? null : new Date(policy.updated_ms),
      updatedBy: policy === undefined ? null : person(policy.updated_by, policy.updated_by_name),
      overrides: overrides
        .filter((row) => usable === undefined || usable.has(row.app_id))
        .map((row) => ({
          app: { id: row.app_id, name: row.app_name },
          tool: row.tool,
          risk: row.risk,
          setBy: person(row.set_by, row.set_by_name),
          setAt: new Date(row.set_ms),
        })),
    };
    return result;
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );

/** Current owners and admins only; the role is read again rather than trusted from the session. */
const administrator = Effect.gen(function* () {
  const actor = yield* currentResourceAuthority;
  if (actor.role === "member") return yield* new OrganizationForbidden();
  return actor;
});

/**
 * Replace every tier's policy, from the revision the edit was read with. The update compares the
 * revision in its own statement; an organization's first save inserts the row only if no other
 * save made one first, so of two edits from one revision exactly one is kept.
 */
const updatePolicy = (input: { readonly revision: string; readonly tiers: Tiers }) =>
  Effect.gen(function* () {
    const actor = yield* administrator;
    const sql = yield* policyDatabase;
    const tiers = JSON.stringify(input.tiers);
    const name = sql`(select left(u.name, ${nameLength}) from "user" u where u.id = ${actor.user})`;
    const updated = yield* sql`update hosted_risk_policies set tiers = ${tiers}::jsonb,
        revision = gen_random_uuid()::text, updated_at = now(), updated_by = ${actor.user},
        updated_by_name = ${name}
      where organization_id = ${actor.organization} and revision = ${input.revision}
      returning organization_id`;
    const inserted =
      updated.length > 0 || input.revision !== defaultRevision
        ? []
        : yield* sql`insert into hosted_risk_policies
              (organization_id, tiers, updated_by, updated_by_name)
            values (${actor.organization}, ${tiers}::jsonb, ${actor.user}, ${name})
            on conflict (organization_id) do nothing
            returning organization_id`;
    if (updated.length === 0 && inserted.length === 0)
      return yield* new AccessConflict({ reason: "changed" });
    return { organization: actor.organization, policy: yield* readPolicy(actor) };
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError() }),
    audited("risk_policy.update", { kind: "organization", id: ({ organization }) => organization }),
    Effect.map(({ policy }) => policy),
  );

/** Set one tool's tier. Only an app of the organization has an access record to file it under. */
const setOverride = (input: {
  readonly app: AppId;
  readonly tool: ToolName;
  readonly risk: RiskTier;
}) =>
  Effect.gen(function* () {
    const actor = yield* administrator;
    const sql = yield* policyDatabase;
    const rows = yield* sql`insert into hosted_tool_risk_overrides
        (organization_id, app_id, tool, risk, set_by, set_by_name)
      select p.organization_id, p.id, ${input.tool}, ${input.risk}, ${actor.user},
        (select left(u.name, ${nameLength}) from "user" u where u.id = ${actor.user})
      from hosted_app_access p
      where p.id = ${input.app} and p.organization_id = ${actor.organization}
      on conflict (organization_id, app_id, tool) do update set risk = excluded.risk,
        set_by = excluded.set_by, set_by_name = excluded.set_by_name, set_at = now()
      returning app_id`;
    if (rows.length === 0) return yield* new AppNotFound({ app: input.app });
    return { app: input.app, policy: yield* readPolicy(actor) };
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError() }),
    audited(
      "risk_policy.override_set",
      { kind: "app", id: ({ app }) => app },
      { risk: input.risk },
    ),
    Effect.map(({ policy }) => policy),
  );

const removeOverride = (input: { readonly app: AppId; readonly tool: ToolName }) =>
  Effect.gen(function* () {
    const actor = yield* administrator;
    const sql = yield* policyDatabase;
    const rows = yield* sql`delete from hosted_tool_risk_overrides
      where organization_id = ${actor.organization} and app_id = ${input.app}
        and tool = ${input.tool}
      returning app_id`;
    return {
      // Only an override that existed names its app.
      app: rows.length > 0 ? input.app : undefined,
      policy: yield* readPolicy(actor),
    };
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError() }),
    audited("risk_policy.override_remove", { kind: "app", id: ({ app }) => app }),
    Effect.map(({ policy }) => policy),
  );

/** The organization's risk policy API. */
export const hostedRiskPolicyHandlers = HttpApiBuilder.group(HostedApi, "riskPolicy", (handlers) =>
  handlers
    .handle("get", () => Effect.flatMap(currentResourceAuthority, readPolicy))
    .handle("update", ({ payload }) => updatePolicy(payload))
    .handle("setOverride", ({ payload }) => setOverride(payload))
    .handle("removeOverride", ({ query }) => removeOverride(query)),
);
