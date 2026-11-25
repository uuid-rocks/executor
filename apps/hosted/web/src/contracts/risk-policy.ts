// JHPATCH: the organization's risk policy, read by every member and changed by administrators
/** The organization's risk policy, with each confirmed write acknowledged in the one read. */
import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { acknowledge } from "@executor-js/ui/contracts/mutations";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { AppId, RiskTier, ToolName } from "@executor-js/sdk";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import type { RiskPolicy } from "@executor-js/hosted-server/risk-policy";
import { HostedClient } from "./api.ts";
import { protectedQuery } from "./protected-query.ts";

export const riskPolicyAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.query("riskPolicy", "get", hydrated({ params: { organization } })).pipe(
    revalidated,
    protectedQuery,
  ),
);

/** Every write answers with the whole policy, which replaces the one on screen. */
const saved = (get: Atom.FnContext, organization: OrganizationReference) => (policy: RiskPolicy) =>
  Effect.sync(() => acknowledge(get, riskPolicyAtom(organization), () => policy));

/** Save the tiers against the revision they were edited from; a stale one is refused. */
export const updateRiskPolicyAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.fn((payload: Pick<RiskPolicy, "revision" | "tiers">, get) =>
    Effect.flatMap(HostedClient, (client) =>
      client.riskPolicy.update({ params: { organization }, payload }),
    ).pipe(
      Effect.tap(saved(get, organization)),
      // Nothing was saved, but the policy may have changed elsewhere.
      Effect.tapError(() => Effect.sync(() => get.refresh(riskPolicyAtom(organization)))),
    ),
  ),
);

export const setRiskOverrideAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.fn(
    (payload: { readonly app: AppId; readonly tool: ToolName; readonly risk: RiskTier }, get) =>
      Effect.flatMap(HostedClient, (client) =>
        client.riskPolicy.setOverride({ params: { organization }, payload }),
      ).pipe(Effect.tap(saved(get, organization))),
  ),
);

export const removeRiskOverrideAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.fn((query: { readonly app: AppId; readonly tool: ToolName }, get) =>
    Effect.flatMap(HostedClient, (client) =>
      client.riskPolicy.removeOverride({ params: { organization }, query }),
    ).pipe(Effect.tap(saved(get, organization))),
  ),
);
