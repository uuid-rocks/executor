// JHPATCH: tool risk tiers and the organization risk policy, over the API and MCP.
/**
 * Every tool lists the risk tier its app declares, computes from each call's input, or takes from
 * its kind and hints. The organization's risk policy acts on each call's tier: it blocks a tier,
 * makes a person approve it even on a connection that approves automatically, or leaves it to the
 * app. Administrators override one tool's tier; members read the policy and cannot change it.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { App } from "../support/contracts.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { approvalMcpUpstream } from "../support/approval-mcp-upstream.ts";
import {
  defaultTiers,
  deployRiskApp,
  editRiskPolicy,
  readRiskPolicy,
  riskApiKey,
  RiskPolicy,
  riskPolicyPath,
} from "../support/risk-policy.ts";

const Catalog = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      risk: Schema.optional(Schema.String),
      riskComputed: Schema.optional(Schema.Boolean),
    }),
  ),
});
/** Each listed tool's name with its tier, or `computed` when the tier depends on the input. */
const tiersOf = (catalog: typeof Catalog.Type) =>
  Object.fromEntries(
    catalog.items.map((tool) => [
      tool.name,
      tool.riskComputed === true ? (tool.risk === undefined ? "computed" : "both") : tool.risk,
    ]),
  );
const Tagged = Schema.Struct({ _tag: Schema.String });
/** One direct MCP `call` that ran. */
const Called = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.Struct({
      ok: Schema.Boolean,
      value: Schema.optional(Schema.Unknown),
      error: Schema.optional(Schema.Struct({ kind: Schema.String, message: Schema.String })),
      callLog: Schema.optional(Schema.Struct({ reference: Schema.String })),
    }),
  }),
});
const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
});
const Resumed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});
/** The parts of a logged call these scenarios assert. */
const LoggedCall = Schema.Struct({
  id: Schema.String,
  tool: Schema.NullOr(Schema.String),
  status: Schema.String,
  errorType: Schema.NullOr(Schema.String),
  risk: Schema.NullOr(Schema.String),
  riskAction: Schema.NullOr(Schema.String),
  approval: Schema.NullOr(Schema.Struct({ decision: Schema.String })),
});
const LogPage = Schema.Struct({ items: Schema.Array(LoggedCall), total: Schema.Number });

type Connection = Effect.Success<ReturnType<McpClient["Service"]["connect"]>>;

/** Call one MCP tool and keep its structured result as evidence. */
const mcpTool = (
  client: Connection,
  label: string,
  name: "call" | "resume",
  args: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const result = yield* client.use(label, (client, signal) =>
      client.callTool({ name, arguments: args }, undefined, { signal }),
    );
    yield* evidence.json(
      `${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.json`,
      result.structuredContent,
    );
    return result.structuredContent;
  });

/** Call `tool` of the risk app over MCP and decode the one call's outcome. */
const callOver = (
  client: Connection,
  slug: string,
  label: string,
  tool: string,
  input: Record<string, unknown>,
) =>
  mcpTool(client, label, "call", {
    calls: { path: `tools[${JSON.stringify(slug)}].${tool}`, input },
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Called)));

/** The logged call a reference names, as the admin reads it. */
const loggedCall = (reference: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const response = yield* api.request(
      actors.admin,
      "GET",
      `/api/organizations/${actors.organization.id}/tool-calls?search=${reference}`,
    );
    const page = yield* body(LogPage, response);
    expect(page.items.map((item) => item.id)).toEqual([reference]);
    return page.items[0] as typeof LoggedCall.Type;
  });

/** The admin's logged calls to `tool` once `done` holds: a call that succeeded is written after it. */
const loggedCallsWhen = (
  app: string,
  tool: string,
  done: (items: ReadonlyArray<typeof LoggedCall.Type>) => boolean,
) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    return yield* api
      .request(
        actors.admin,
        "GET",
        `/api/organizations/${actors.organization.id}/tool-calls?app=${app}&tool=${tool}&range=24h`,
      )
      .pipe(
        Effect.flatMap((response) => body(LogPage, response)),
        Effect.map((page) => page.items),
        Effect.repeat({ until: done, schedule: Schedule.spaced("100 millis") }),
        Effect.timeout("10 seconds"),
      );
  });

const override = (
  actor: Session,
  method: "PUT" | "DELETE",
  app: string,
  tool: string,
  risk?: string,
) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const path = `${yield* riskPolicyPath}/overrides`;
    return method === "PUT"
      ? yield* api.request(actor, "PUT", path, { app, tool, risk })
      : yield* api.request(actor, "DELETE", `${path}?app=${app}&tool=${tool}`);
  });

layer(HostedLive, { excludeTestServices: true })("Tool risk policy", (it) => {
  it.effect(scenarios.toolRiskListings.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const { path } = yield* deployRiskApp;
        const listed = yield* api.request(actors.member, "GET", `${path}/tools`);
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        // A tier the app declares is listed as it is; a tier computed from each call's input is
        // listed as computed, with no tier; a tool that declares none takes its kind's default,
        // and a destructive hint makes a write high.
        expect(tiersOf(yield* body(Catalog, listed))).toEqual({
          read: "low",
          write: "medium",
          erase: "high",
          wipe: "critical",
          deploy: "computed",
          rotate: "high",
          purge: "critical",
          review: "medium",
          archive: "high",
        });
      }),
    ),
  );

  it.effect(scenarios.toolRiskImportedMcp.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          upstream = yield* approvalMcpUpstream;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const imported = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
          source: {
            kind: "mcp",
            name: `Risk hints ${randomUUID().slice(0, 8)}`,
            url: `${upstream.origin}/mcp`,
          },
        });
        expect(imported.status, JSON.stringify(imported.body)).toBe(200);
        const path = `${prefix}/apps/${(yield* body(App, imported)).id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        // An MCP server's tools take their tier from its hints: a read-only hint reads, so it is
        // low even beside a destructive one; a destructive write is high; any other write medium.
        expect(
          tiersOf(yield* body(Catalog, yield* api.request(actors.owner, "GET", `${path}/tools`))),
        ).toEqual({
          read: "low",
          safe: "medium",
          unhinted: "medium",
          erase: "high",
          conflict: "low",
        });
      }),
    ),
  );

  it.effect(scenarios.toolRiskEnforcement.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          mcp = yield* McpClient;
        const { app } = yield* deployRiskApp;
        const key = yield* riskApiKey(actors.owner, `Risk agent ${randomUUID().slice(0, 6)}`);
        const client = yield* mcp.connect(key.key, "risk-enforcement", {
          organization: actors.organization.id,
        });
        yield* editRiskPolicy(actors.admin, (tiers) => ({
          ...tiers,
          critical: { ...tiers.critical, approval: "deny" },
        }));

        // A critical call is blocked before it runs; the agent is told the organization's policy
        // blocked it, not the app, and at which tier.
        const wiped = yield* callOver(client, app.slug, "Call a critical tool", "wipe", {
          id: "w1",
        });
        expect(wiped.execution.value).toMatchObject({ ok: false });
        expect(wiped.execution.value.value).toBeUndefined();
        expect(wiped.execution.value.error?.message).toContain(
          "The organization’s risk policy blocks critical-risk calls, so this call to “wipe” did not run.",
        );
        const wipedRow = yield* loggedCall(wiped.execution.value.callLog?.reference ?? "");
        expect(wipedRow).toMatchObject({
          tool: "wipe",
          // A blocked call reads as denied, whoever blocked it.
          status: "denied",
          errorType: "ToolBlocked",
          risk: "critical",
          riskAction: "deny",
        });

        // A tier computed from the input blocks the production deploy and runs the staging one.
        const production = yield* callOver(client, app.slug, "Deploy to production", "deploy", {
          env: "prod",
        });
        expect(production.execution.value.ok).toBe(false);
        expect(production.execution.value.error?.message).toContain(
          "blocks critical-risk calls, so this call to “deploy” did not run.",
        );
        expect(
          yield* loggedCall(production.execution.value.callLog?.reference ?? ""),
        ).toMatchObject({ risk: "critical", riskAction: "deny" });
        const staging = yield* callOver(client, app.slug, "Deploy to staging", "deploy", {
          env: "staging",
        });
        expect(staging.execution.value).toMatchObject({ ok: true, value: { deployed: "staging" } });
        const deploys = yield* loggedCallsWhen(app.id, "deploy", (items) =>
          items.some((item) => item.status === "succeeded"),
        );
        expect(deploys.map((item) => [item.status, item.risk, item.riskAction])).toEqual([
          ["succeeded", "low", null],
          ["denied", "critical", "deny"],
        ]);

        // An admin's override makes a read critical, so the policy blocks it; removed, the read
        // runs at its own tier again.
        const set = yield* override(actors.admin, "PUT", app.id, "read", "critical");
        expect(set.status, JSON.stringify(set.body)).toBe(200);
        expect((yield* body(RiskPolicy, set)).overrides).toMatchObject([
          { app: { id: app.id, name: app.name }, tool: "read", risk: "critical" },
        ]);
        const overridden = yield* callOver(
          client,
          app.slug,
          "Read at the override's tier",
          "read",
          {
            id: "r1",
          },
        );
        expect(overridden.execution.value.ok).toBe(false);
        expect(
          yield* loggedCall(overridden.execution.value.callLog?.reference ?? ""),
        ).toMatchObject({ tool: "read", risk: "critical", riskAction: "deny" });
        const removed = yield* override(actors.admin, "DELETE", app.id, "read");
        expect(removed.status, JSON.stringify(removed.body)).toBe(200);
        expect((yield* body(RiskPolicy, removed)).overrides).toEqual([]);
        const restored = yield* callOver(client, app.slug, "Read at its own tier", "read", {
          id: "r2",
        });
        expect(restored.execution.value).toMatchObject({ ok: true, value: { read: "r2" } });
        const reads = yield* loggedCallsWhen(app.id, "read", (items) =>
          items.some((item) => item.status === "succeeded"),
        );
        expect(reads.map((item) => [item.status, item.risk])).toEqual([
          ["succeeded", "low"],
          ["denied", "critical"],
        ]);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolRiskAskAutomatic.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          mcp = yield* McpClient;
        const { app } = yield* deployRiskApp;
        const key = yield* riskApiKey(actors.owner, `Automatic agent ${randomUUID().slice(0, 6)}`);
        const client = yield* mcp.connect(key.key, "risk-automatic", {
          organization: actors.organization.id,
          mode: "automatic",
        });
        // The connection approves automatically: a tool whose app always asks runs at once.
        const reviewed = yield* callOver(
          client,
          app.slug,
          "Call a tool the app asks about",
          "review",
          {
            id: "v1",
          },
        );
        expect(reviewed.execution.value).toMatchObject({ ok: true, value: { reviewed: "v1" } });

        yield* editRiskPolicy(actors.admin, (tiers) => ({
          ...tiers,
          high: { ...tiers.high, approval: "ask" },
        }));
        // `erase` never asks on its own and is high: the policy makes a person approve it, which
        // the connection's automatic approval does not stand in for.
        const outcome = yield* mcpTool(
          client,
          "Call a high-risk tool the app never asks about",
          "call",
          {
            calls: { path: `tools[${JSON.stringify(app.slug)}].erase`, input: { id: "e1" } },
          },
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Schema.Struct({ status: Schema.String }))(outcome))
            .status,
          `the call waits for a person, not the connection: ${JSON.stringify(outcome)}`,
        ).toBe("approval-required");
        const paused = yield* Schema.decodeUnknownEffect(Pending)(outcome);
        const waiting = yield* loggedCallsWhen(app.id, "erase", (items) => items.length === 1);
        expect(waiting).toMatchObject([
          {
            status: "awaiting-approval",
            risk: "high",
            riskAction: "ask",
            approval: { decision: "pending" },
          },
        ]);
        // Approving it runs the call.
        const resumed = yield* Schema.decodeUnknownEffect(Resumed)(
          yield* mcpTool(client, "Approve the high-risk call", "resume", {
            requestId: paused.requestId,
            response: { action: "accept" },
          }),
        );
        expect(resumed.execution.value).toMatchObject({ ok: true, value: { erased: "e1" } });
        const approved = yield* loggedCallsWhen(app.id, "erase", (items) =>
          items.some((item) => item.status === "succeeded"),
        );
        expect(approved).toMatchObject([
          {
            status: "succeeded",
            risk: "high",
            riskAction: "ask",
            approval: { decision: "approved" },
          },
        ]);

        // A block holds even for a call a person approves: the next call pauses, the policy then
        // blocks its tier, and approving it refuses it. The log says the person approved it and
        // the policy blocked it, not that the person declined it.
        const second = yield* Schema.decodeUnknownEffect(Pending)(
          yield* mcpTool(client, "Call the high-risk tool again", "call", {
            calls: { path: `tools[${JSON.stringify(app.slug)}].erase`, input: { id: "e2" } },
          }),
        );
        yield* editRiskPolicy(actors.admin, (tiers) => ({
          ...tiers,
          high: { ...tiers.high, approval: "deny" },
        }));
        const refused = yield* mcpTool(
          client,
          "Approve the call after the policy blocks its tier",
          "resume",
          { requestId: second.requestId, response: { action: "accept" } },
        );
        expect(refused, JSON.stringify(refused)).toMatchObject({
          execution: { value: { ok: false, error: { response: { code: "ToolBlocked" } } } },
        });
        const blocked = yield* loggedCallsWhen(app.id, "erase", (items) =>
          items.some((item) => item.status === "denied"),
        );
        expect(blocked.find((item) => item.status === "denied")).toMatchObject({
          errorType: "ToolBlocked",
          risk: "high",
          riskAction: "deny",
          approval: { decision: "approved" },
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolRiskPolicyAccess.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const policyPath = yield* riskPolicyPath;
        const { app, prefix } = yield* deployRiskApp;
        // An app only owners and admins may use.
        const hidden = yield* deployRiskApp;
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${hidden.path}/access`),
        );
        const made = yield* api.request(actors.owner, "PATCH", `${hidden.path}/access`, {
          revision: access.revision,
          audience: { kind: "private" },
        });
        expect(made.status, JSON.stringify(made.body)).toBe(200);
        expect(prefix).toBe(hidden.prefix);

        // Before anyone saves one, every member reads the defaults.
        const initial = yield* readRiskPolicy(actors.member);
        expect(initial).toMatchObject({
          tiers: defaultTiers,
          revision: "default",
          updatedAt: null,
          updatedBy: null,
          overrides: [],
        });

        // A member changes neither the tiers nor an override.
        for (const [label, response] of [
          [
            "tiers",
            yield* api.request(actors.member, "PUT", policyPath, {
              revision: initial.revision,
              tiers: { ...defaultTiers, low: { approval: "deny", recordArguments: true } },
            }),
          ],
          ["override", yield* override(actors.member, "PUT", app.id, "read", "critical")],
          ["removal", yield* override(actors.member, "DELETE", app.id, "read")],
        ] as const) {
          expect(response.status, `${label}: ${JSON.stringify(response.body)}`).toBe(403);
          expect((yield* body(Tagged, response))._tag, label).toBe("OrganizationForbidden");
        }
        expect(yield* readRiskPolicy(actors.owner)).toMatchObject({
          tiers: defaultTiers,
          revision: "default",
        });

        // The admin saves; the owner's edit from the revision both read is refused and changes
        // nothing.
        const saved = yield* editRiskPolicy(actors.admin, (tiers) => ({
          ...tiers,
          medium: { approval: "ask", recordArguments: true },
        }));
        expect(saved.revision).not.toBe("default");
        expect(saved.updatedBy?.id).toEqual(expect.any(String));
        const stale = yield* api.request(actors.owner, "PUT", policyPath, {
          revision: initial.revision,
          tiers: { ...defaultTiers, low: { approval: "deny", recordArguments: false } },
        });
        expect(stale.status, JSON.stringify(stale.body)).toBe(409);
        expect((yield* body(Tagged, stale))._tag).toBe("AccessConflict");
        const kept = yield* readRiskPolicy(actors.owner);
        expect(kept.revision).toBe(saved.revision);
        expect(kept.tiers).toEqual({
          ...defaultTiers,
          medium: { approval: "ask", recordArguments: true },
        });

        // A member reads the overrides of apps they may use, not of the app kept from them.
        for (const target of [app.id, hidden.app.id]) {
          const set = yield* override(actors.owner, "PUT", target, "write", "high");
          expect(set.status, JSON.stringify(set.body)).toBe(200);
        }
        const overridden = (policy: RiskPolicy) =>
          policy.overrides.map((entry) => [entry.app.id, entry.tool, entry.risk]).sort();
        expect(overridden(yield* readRiskPolicy(actors.member))).toEqual([
          [app.id, "write", "high"],
        ]);
        expect(overridden(yield* readRiskPolicy(actors.admin))).toEqual(
          [
            [app.id, "write", "high"],
            [hidden.app.id, "write", "high"],
          ].sort(),
        );
      }),
    ),
  );
});
