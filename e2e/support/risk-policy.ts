// JHPATCH: fixtures for the tool risk tier and organization risk policy scenarios.
/**
 * An app whose tools carry every kind of risk tier, the organization's risk policy as its API
 * returns it, and the edits the risk scenarios make to it, all through the product's public API.
 */
import { expect } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "./actors.ts";
import { Api, body, type Session } from "./api.ts";
import { App } from "./contracts.ts";
import { appsManifest } from "./apps-release.ts";

/**
 * One tool per way a tier is set. `read` and `write` declare none, so they take their kind's
 * default; `erase` takes the default of its destructive hint and never asks on its own; `wipe`
 * declares one; `deploy` computes one from its input; `rotate` and `purge` get theirs from
 * `withRisk` and `withRisks`; `review` asks for approval itself; `archive` is recorded by default
 * and takes the secrets the log must not keep.
 */
const source = `
import { defineApp, mutation, query, object, string, router, withRisk, withRisks } from "apps";
import { always, never } from "apps/operations/approval";
const record = object({ id: string() });
export default defineApp({}, async () => ({ tools: withRisks(router({
  read: query({ description: "Read a record", input: record }, async (_, input) => ({ read: input.id })),
  write: mutation({ description: "Write a record", input: record }, async (_, input) => ({ wrote: input.id })),
  erase: mutation({ description: "Erase a record", input: record, annotations: { destructiveHint: true }, approval: never() },
    async (_, input) => ({ erased: input.id })),
  wipe: mutation({ description: "Wipe every record", input: record, risk: "critical" }, async (_, input) => ({ wiped: input.id })),
  deploy: mutation({ description: "Deploy to an environment", input: object({ env: string() }),
    risk: async ({ toolInput }) => (toolInput.env === "prod" ? "critical" : "low") },
    async (_, input) => ({ deployed: input.env })),
  rotate: withRisk(mutation({ description: "Rotate a key", input: record }, async (_, input) => ({ rotated: input.id })), "high"),
  purge: query({ description: "Purge a cache", input: record }, async (_, input) => ({ purged: input.id })),
  review: mutation({ description: "Needs approval", input: record, approval: always() }, async (_, input) => ({ reviewed: input.id })),
  archive: mutation({ description: "Archive with credentials", risk: "high",
    input: object({ id: string(), password: string(), note: string(), options: object({ apiKey: string(), label: string() }), memo: string() }) },
    async (_, input) => ({ archived: input.id })),
}), (_tool, name) => (name === "purge" ? "critical" : undefined)) }));`;

export const RiskTierPolicy = Schema.Struct({
  approval: Schema.Literals(["app", "ask", "deny"]),
  recordArguments: Schema.Boolean,
});
export const RiskTiers = Schema.Struct({
  low: RiskTierPolicy,
  medium: RiskTierPolicy,
  high: RiskTierPolicy,
  critical: RiskTierPolicy,
});
export type RiskTiers = typeof RiskTiers.Type;
const Person = Schema.NullOr(
  Schema.Struct({ id: Schema.NullOr(Schema.String), name: Schema.NullOr(Schema.String) }),
);
export const RiskPolicy = Schema.Struct({
  tiers: RiskTiers,
  revision: Schema.String,
  updatedAt: Schema.NullOr(Schema.String),
  updatedBy: Person,
  overrides: Schema.Array(
    Schema.Struct({
      app: Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }),
      tool: Schema.String,
      risk: Schema.String,
      setBy: Person,
      setAt: Schema.String,
    }),
  ),
});
export type RiskPolicy = typeof RiskPolicy.Type;

/** The policy of an organization that never saved one, as the product documents it. */
export const defaultTiers: RiskTiers = {
  low: { approval: "app", recordArguments: false },
  medium: { approval: "app", recordArguments: false },
  high: { approval: "app", recordArguments: true },
  critical: { approval: "ask", recordArguments: true },
};

export const riskPolicyPath = Effect.gen(function* () {
  const actors = yield* Actors;
  return `/api/organizations/${actors.organization.id}/risk-policy`;
});

export const readRiskPolicy = (actor: Session) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const response = yield* api.request(actor, "GET", yield* riskPolicyPath);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return yield* body(RiskPolicy, response);
  });

/** Apply `change` to the policy `actor` reads now, saved from the revision it read. */
export const editRiskPolicy = (actor: Session, change: (tiers: RiskTiers) => RiskTiers) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const current = yield* readRiskPolicy(actor);
    const response = yield* api.request(actor, "PUT", yield* riskPolicyPath, {
      revision: current.revision,
      tiers: change(current.tiers),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return yield* body(RiskPolicy, response);
  });

/** The owner deploys the risk app, shared with everyone so every member may call it. */
export const deployRiskApp = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: `Risk desk ${randomUUID().slice(0, 8)}`,
    files: [{ path: "index.ts", content: source }, appsManifest],
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(App, deployed);
  const path = `${prefix}/apps/${app.id}`;
  yield* Effect.addFinalizer(() => api.request(actors.owner, "DELETE", path).pipe(Effect.orDie));
  const access = yield* body(
    Schema.Struct({ revision: Schema.String }),
    yield* api.request(actors.owner, "GET", `${path}/access`),
  );
  const shared = yield* api.request(actors.owner, "PATCH", `${path}/access`, {
    revision: access.revision,
    audience: { kind: "everyone" },
  });
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);
  return { app, path, prefix };
});

const Key = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });

/** A personal API key for `actor`, deleted when the scenario ends. */
export const riskApiKey = (actor: Session, name: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const key = yield* body(
      Key,
      yield* api.request(actor, "POST", "/api/auth/api-key/create", { name }),
    );
    yield* Effect.addFinalizer(() =>
      api.request(actor, "POST", "/api/auth/api-key/delete", { keyId: key.id }).pipe(Effect.orDie),
    );
    return { ...key, bearer: { authorization: `Bearer ${Redacted.value(key.key)}` } };
  });

/**
 * `value` with each secret replaced by its label, so a failed comparison's diff, which the job log
 * prints whole, names the secret that leaked rather than showing it.
 */
export const labelSecrets = (value: unknown, labels: Readonly<Record<string, string>>): unknown =>
  JSON.parse(
    Object.entries(labels).reduce(
      (text, [secretValue, label]) => text.replaceAll(secretValue, label),
      JSON.stringify(value) ?? "null",
    ),
  );
