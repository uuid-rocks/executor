// JHPATCH: organizations decide what each tool risk tier does and may override a tool's tier.
/**
 * An organization's risk policy: for each risk tier, whether a call needs a person's approval or is
 * blocked, and whether its arguments are kept in the tool call log; and administrators' overrides of
 * the tier an app declares for one of its tools. Every member may read it; owners and admins edit it.
 */
import {
  AppId,
  AppNotFound,
  RiskAction,
  RiskTier,
  StorageError,
  ToolName,
} from "@executor-js/sdk/core";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { AuthenticationUnavailable } from "./auth.ts";
import { RequiredAction } from "./authorization.ts";
import {
  OrganizationForbidden,
  OrganizationReference,
  RequireOrganization,
} from "./organization.ts";
import { AccessConflict } from "./resource-access.ts";

/** What the policy does with calls of one tier. */
export const RiskTierPolicy = Schema.Struct({
  /**
   * `app`: the app's own approval decides. `ask`: a person must approve every call, even when the
   * app would not ask and under automatic approval. `deny`: the call is blocked before it runs.
   */
  approval: RiskAction,
  /** Keep the call's arguments, with secrets removed, in the tool call log. */
  recordArguments: Schema.Boolean,
});
export type RiskTierPolicy = typeof RiskTierPolicy.Type;

/** The policy of every tier. */
export const RiskTiers = Schema.Struct({
  low: RiskTierPolicy,
  medium: RiskTierPolicy,
  high: RiskTierPolicy,
  critical: RiskTierPolicy,
});
export type RiskTiers = typeof RiskTiers.Type;

/** The policy of an organization that never saved one. */
export const defaultRiskTiers: RiskTiers = {
  low: { approval: "app", recordArguments: false },
  medium: { approval: "app", recordArguments: false },
  high: { approval: "app", recordArguments: true },
  critical: { approval: "ask", recordArguments: true },
};

/** Who changed something: their name copied when they did; the ID is null once they are deleted. */
export const RiskPolicyPerson = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
});

/** An administrator's tier for one tool, replacing the tier its app declares. */
export const RiskOverride = Schema.Struct({
  app: Schema.Struct({
    id: AppId,
    /** The app's current name; null only if its record could not be read. */
    name: Schema.NullOr(Schema.String),
  }),
  tool: ToolName,
  risk: RiskTier,
  setBy: Schema.NullOr(RiskPolicyPerson),
  setAt: Schema.Date,
});
export type RiskOverride = typeof RiskOverride.Type;

const Revision = Schema.NonEmptyString.check(Schema.isMaxLength(200));

export const RiskPolicy = Schema.Struct({
  tiers: RiskTiers,
  /** Send it back with an edit; an edit made from an older revision fails with AccessConflict. */
  revision: Schema.String,
  /** Null while the organization uses the defaults. */
  updatedAt: Schema.NullOr(Schema.Date),
  updatedBy: Schema.NullOr(RiskPolicyPerson),
  /** Overrides of apps the caller may use; every override for owners and admins. */
  overrides: Schema.Array(RiskOverride),
});
export type RiskPolicy = typeof RiskPolicy.Type;

const path = "/api/organizations/:organization/risk-policy";
const organization = { organization: OrganizationReference };
const errors = [AuthenticationUnavailable, OrganizationForbidden, StorageError] as const;
const OverrideTarget = Schema.Struct({ app: AppId, tool: ToolName });

/**
 * The organization's risk policy. The policy is stricter-wins: it never runs a call the app itself
 * would block or ask about without asking.
 */
export const HostedRiskPolicy = HttpApiGroup.make("riskPolicy")
  .add(
    HttpApiEndpoint.get("get", path, {
      params: organization,
      success: RiskPolicy,
      error: errors,
    })
      .annotate(RequiredAction, "read")
      .annotate(
        OpenApi.Description,
        "Read the organization's risk policy. Each tool call is evaluated at a risk tier (low, medium, high or critical) that the app declares, derives from the call's input, or that an administrator override sets. For each tier the policy says what happens: approval `app` lets the app's own approval decide, `ask` makes a person approve every call (even under automatic approval), `deny` blocks the call before it runs. `recordArguments` keeps the call's arguments, with secrets removed, in the tool call log. Every member may read it; members see only overrides of apps they may use.",
      ),
  )
  .add(
    HttpApiEndpoint.put("update", path, {
      params: organization,
      payload: Schema.Struct({
        /** The revision the edit was made from. */
        revision: Revision,
        tiers: RiskTiers,
      }),
      success: RiskPolicy,
      error: [...errors, AccessConflict],
    })
      .annotate(RequiredAction, "manage")
      .annotate(
        OpenApi.Description,
        "Replace the policy of every risk tier. Owners and admins only. Send the revision the edit was read with; if the policy changed since, it fails with AccessConflict: read it again and reapply the edit. New calls use the change at once; calls already waiting for approval are checked again when they resume.",
      ),
  )
  .add(
    HttpApiEndpoint.put("setOverride", `${path}/overrides`, {
      params: organization,
      payload: Schema.Struct({ ...OverrideTarget.fields, risk: RiskTier }),
      success: RiskPolicy,
      error: [...errors, AppNotFound],
    })
      .annotate(RequiredAction, "manage")
      .annotate(
        OpenApi.Description,
        "Set the risk tier of one tool of an organization app, replacing whatever tier the app declares or computes from the input. Owners and admins only. The app must be the organization's (AppNotFound otherwise); the tool is named as the app lists it. Setting it again replaces the earlier override.",
      ),
  )
  .add(
    HttpApiEndpoint.delete("removeOverride", `${path}/overrides`, {
      params: organization,
      query: OverrideTarget,
      success: RiskPolicy,
      error: errors,
    })
      .annotate(RequiredAction, "manage")
      .annotate(
        OpenApi.Description,
        "Remove the override of one tool, so its calls are evaluated at the tier the app declares again. Owners and admins only. Removing an override that does not exist changes nothing.",
      ),
  )
  .middleware(RequireOrganization);
