// JHPATCH: the organization's risk policy on schedules, older builds and imported OpenAPI routers.
/**
 * The risk policy acts on every way a tool is called and every way its tier is set. A schedule
 * that approves automatically still waits for a person when the policy asks, and the tool call log
 * records each of its runs' calls. A build from before risk policies cannot ask, so the policy
 * blocks what it would ask about and says to redeploy; its tools list the tiers the policy
 * enforces. An OpenAPI router's operations take their tier from their HTTP method. A caller that
 * cannot answer an approval is told the call did not run.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { App } from "../support/contracts.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { appsManifest } from "../support/apps-release.ts";
import { openapiAppFiles } from "../support/authored-templates.ts";
import {
  deployRiskApp,
  editRiskPolicy,
  recordsUpstream,
  riskApiKey,
} from "../support/risk-policy.ts";

const Run = Schema.Struct({ id: Schema.String, status: Schema.String });
const Runs = Schema.Array(Run);
const LoggedCall = Schema.Struct({
  tool: Schema.NullOr(Schema.String),
  status: Schema.String,
  errorType: Schema.NullOr(Schema.String),
  risk: Schema.NullOr(Schema.String),
  riskAction: Schema.NullOr(Schema.String),
});
const LogPage = Schema.Struct({ items: Schema.Array(LoggedCall) });
const Person = Schema.NullOr(Schema.Struct({ id: Schema.NullOr(Schema.String) }));
/** A scheduled run's call as the log records it. */
const ScheduledCall = Schema.Struct({
  ...LoggedCall.fields,
  member: Person,
  source: Schema.Struct({
    kind: Schema.String,
    id: Schema.NullOr(Schema.String),
    name: Schema.NullOr(Schema.String),
  }),
  run: Schema.NullOr(Schema.Struct({ id: Schema.String })),
  kind: Schema.NullOr(Schema.String),
  arguments: Schema.NullOr(Schema.Struct({ value: Schema.Unknown, truncated: Schema.Boolean })),
  approval: Schema.NullOr(Schema.Struct({ decision: Schema.String, decidedBy: Person })),
});
const ScheduledLog = Schema.Struct({ items: Schema.Array(ScheduledCall) });
const Viewer = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) });
const Settings = Schema.Struct({ id: Schema.String });
const ApprovalRequired = Schema.Struct({
  _tag: Schema.Literal("ToolApprovalRequired"),
  message: Schema.String,
});
const Catalog = Schema.Struct({
  items: Schema.Array(Schema.Struct({ name: Schema.String, risk: Schema.optional(Schema.String) })),
});
const Blocked = Schema.Struct({
  _tag: Schema.Literal("ToolBlocked"),
  message: Schema.String,
  recovery: Schema.Struct({ action: Schema.String }),
});

/** Deploy `files` as the owner, removed when the scenario ends. */
const deploy = (name: string, files: ReadonlyArray<{ path: string; content: string }>) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: `${name} ${randomUUID().slice(0, 8)}`,
      files,
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = yield* body(App, deployed);
    const path = `${prefix}/apps/${app.id}`;
    yield* Effect.addFinalizer(() => api.request(actors.owner, "DELETE", path).pipe(Effect.orDie));
    return { app, path, prefix };
  });

/** Call a tool of the app at `path` over the HTTP API with `actor`'s API key. */
const caller = (actor: Session, path: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const key = yield* riskApiKey(actor, `Risk paths ${randomUUID().slice(0, 6)}`);
    const agent = yield* api.session();
    return (tool: string, input: Record<string, unknown>) =>
      api.request(agent, "POST", `${path}/tools/call`, { tool, input }, key.bearer);
  });

/** The admin's logged calls of `app` once `done` holds: a finished call is written after it. */
const loggedCallsWhen = (
  app: string,
  done: (items: ReadonlyArray<typeof LoggedCall.Type>) => boolean,
) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    return yield* api
      .request(
        actors.admin,
        "GET",
        `/api/organizations/${actors.organization.id}/tool-calls?app=${app}&range=24h`,
      )
      .pipe(
        Effect.flatMap((response) => body(LogPage, response)),
        Effect.map((page) => page.items),
        Effect.repeat({ until: done, schedule: Schedule.spaced("100 millis") }),
        Effect.timeout("20 seconds"),
      );
  });

/** Each listed tool's name with its tier. */
const tiersOf = (catalog: typeof Catalog.Type) =>
  Object.fromEntries(catalog.items.map((tool) => [tool.name, tool.risk]));

/** The signed-in user's ID. */
const userId = (actor: Session) =>
  Effect.gen(function* () {
    const api = yield* Api;
    return (yield* body(Viewer, yield* api.request(actor, "GET", "/api/auth/get-session"))).user.id;
  });

const scheduledSource = `import { defineApp, mutation, userInterval, object, string, router } from "apps";
import { never } from "apps/operations/approval";
const purge = mutation({ description: "Purge old records", input: object({ older: string() }), risk: "high", approval: never() },
  async () => ({ purged: true }));
export default defineApp({}, async () => ({ tools: router({ purge }), schedules: { nightly: userInterval({ minutes: 1 }, purge, { older: "30d" }) } }));`;

/** The newest published `apps` release, built before risk tiers and the `riskPolicy` capability. */
const beforeRisk = "0.0.1-beta.140";
const olderSource = `import { defineApp, mutation, query, object, string, router } from "apps";
const record = object({ id: string() });
export default defineApp({}, async () => ({ tools: router({
  read: query({ description: "Read a record", input: record }, async (_, input) => ({ read: input.id })),
  write: mutation({ description: "Write a record", input: record }, async (_, input) => ({ wrote: input.id })),
  erase: mutation({ description: "Erase a record", input: record, annotations: { destructiveHint: true } },
    async (_, input) => ({ erased: input.id })),
}) }));`;

/** One record path with a read, a replace and a delete; the router names tools by tag. */
const recordsDocument = {
  openapi: "3.1.0",
  info: { title: "Risk records", version: "1" },
  paths: {
    "/records/{id}": Object.fromEntries(
      (
        [
          ["get", "getRecord"],
          ["put", "replaceRecord"],
          ["delete", "deleteRecord"],
        ] as const
      ).map(([method, operationId]) => [
        method,
        {
          tags: ["records"],
          operationId,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "Answered",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      ]),
    ),
  },
};

layer(HostedLive, { excludeTestServices: true })("Tool risk policy paths", (it) => {
  it.effect(scenarios.toolRiskScheduleAsk.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const { app, path, prefix } = yield* deploy("Risk schedule", [
          { path: "index.ts", content: scheduledSource },
          appsManifest,
        ]);
        // Shared, so the admin may use the app and answer its runs' approvals.
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        const shared = yield* api.request(actors.owner, "PATCH", `${path}/access`, {
          revision: access.revision,
          audience: { kind: "everyone" },
        });
        expect(shared.status, JSON.stringify(shared.body)).toBe(200);
        const schedule = `${path}/schedules/nightly`;
        const configured = yield* api.request(actors.owner, "PATCH", schedule, {
          enabled: true,
          approvalMode: "automatic",
        });
        expect(configured.status, JSON.stringify(configured.body)).toBe(200);
        const copy = (yield* body(Settings, configured)).id;
        const [ownerId, adminId] = yield* Effect.all([userId(actors.owner), userId(actors.admin)]);
        /** The admin's logged calls of the app once `done` holds. */
        const loggedWhen = (done: (items: ReadonlyArray<typeof ScheduledCall.Type>) => boolean) =>
          api.request(actors.admin, "GET", `${prefix}/tool-calls?app=${app.id}&range=24h`).pipe(
            Effect.flatMap((response) => body(ScheduledLog, response)),
            Effect.map((page) => page.items),
            Effect.repeat({ until: done, schedule: Schedule.spaced("100 millis") }),
            Effect.timeout("20 seconds"),
          );
        /** What the log says of one run's call. */
        const loggedRun = (items: ReadonlyArray<typeof ScheduledCall.Type>, run: string) => {
          const item = items.find((each) => each.run?.id === run);
          return item === undefined
            ? undefined
            : {
                member: item.member?.id,
                source: item.source,
                tool: item.tool,
                kind: item.kind,
                status: item.status,
                risk: item.risk,
                riskAction: item.riskAction,
                arguments: item.arguments,
                approval:
                  item.approval === null
                    ? null
                    : { decision: item.approval.decision, decidedBy: item.approval.decidedBy?.id },
              };
        };
        // Each run's call is logged as the schedule's, run as its member, with its arguments,
        // which the default policy records for high calls.
        const scheduled = {
          member: ownerId,
          source: { kind: "schedule", id: copy, name: "nightly" },
          tool: "purge",
          kind: "mutation",
          risk: "high",
          arguments: { value: { older: "30d" }, truncated: false },
        };
        const runs = (pending?: boolean) =>
          api
            .request(
              actors.owner,
              "GET",
              `${prefix}/scheduled-runs?app=${app.id}${pending === true ? "&pending=true" : ""}`,
            )
            .pipe(Effect.flatMap((response) => body(Runs, response)));
        /** Start a run and wait until it has done what it can without a person. */
        const runOnce = Effect.gen(function* () {
          const before = new Set((yield* runs()).map((run) => run.id));
          const started = yield* api.request(actors.owner, "POST", `${schedule}/run`);
          expect(started.status, JSON.stringify(started.body)).toBe(200);
          const settled = yield* runs().pipe(
            Effect.map((rows) =>
              rows.find((run) => !before.has(run.id) && run.status !== "running"),
            ),
            Effect.repeat({
              until: (run) => run !== undefined,
              schedule: Schedule.spaced("100 millis"),
            }),
            Effect.timeout("20 seconds"),
          );
          return settled as typeof Run.Type;
        });

        // The schedule approves automatically, and the app never asks: the run finishes alone.
        const alone = yield* runOnce;
        expect(alone.status).toBe("succeeded");
        expect(
          loggedRun(
            yield* loggedWhen((items) => loggedRun(items, alone.id) !== undefined),
            alone.id,
          ),
        ).toEqual({ ...scheduled, status: "succeeded", riskAction: null, approval: null });

        yield* editRiskPolicy(actors.admin, (tiers) => ({
          ...tiers,
          high: { ...tiers.high, approval: "ask" },
        }));
        // The policy asks about high calls, which the schedule's automatic approval does not
        // answer: the run waits in the inbox for a person.
        const waiting = yield* runOnce;
        expect(waiting.status, "the run waits for a person, not the schedule").toBe(
          "awaiting-approval",
        );
        expect((yield* runs(true)).map((run) => run.id)).toEqual([waiting.id]);
        const asked = { ...scheduled, riskAction: "ask" };
        // The log shows the call waiting for approval, which the policy asked for.
        expect(loggedRun(yield* loggedWhen(() => true), waiting.id)).toEqual({
          ...asked,
          status: "awaiting-approval",
          approval: { decision: "pending", decidedBy: undefined },
        });
        /** Answer a waiting run in the inbox as `actor`, and wait for the run to end. */
        const answer = (actor: Session, run: string, action: "accept" | "decline") =>
          Effect.gen(function* () {
            const endpoint = `${prefix}/scheduled-runs/${run}/approval`;
            expect((yield* api.request(actor, "GET", endpoint)).body).toMatchObject({
              status: "pending",
            });
            expect(
              (yield* api.request(actor, "POST", endpoint, {
                response: { action, content: {} },
              })).body,
            ).toEqual({ status: "answered" });
            return yield* runs().pipe(
              Effect.map((rows) => rows.find((each) => each.id === run)?.status),
              Effect.repeat({
                until: (status) =>
                  status !== "awaiting-approval" && status !== "ready" && status !== "running",
                schedule: Schedule.spaced("100 millis"),
              }),
              Effect.timeout("20 seconds"),
            );
          });

        // The admin approves it in the inbox, which runs the tool; the log names the admin, not
        // the schedule's member, as who approved it.
        expect(yield* answer(actors.admin, waiting.id, "accept")).toBe("succeeded");
        expect(yield* runs(true)).toEqual([]);
        expect(
          loggedRun(
            yield* loggedWhen((items) => loggedRun(items, waiting.id)?.status === "succeeded"),
            waiting.id,
          ),
        ).toEqual({
          ...asked,
          status: "succeeded",
          approval: { decision: "approved", decidedBy: adminId },
        });

        // Declining the next run refuses the call, and the log says who declined it.
        const declined = yield* runOnce;
        expect(declined.status).toBe("awaiting-approval");
        expect(yield* answer(actors.owner, declined.id, "decline")).toBe("denied");
        expect(
          loggedRun(
            yield* loggedWhen((items) => loggedRun(items, declined.id)?.status === "denied"),
            declined.id,
          ),
        ).toEqual({
          ...asked,
          status: "denied",
          approval: { decision: "denied", decidedBy: ownerId },
        });
      }),
    ),
  );

  it.effect(scenarios.toolRiskOlderBuild.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const { app, path } = yield* deploy("Risk older build", [
          { path: "index.ts", content: olderSource },
          {
            path: "package.json",
            content: JSON.stringify({ dependencies: { apps: beforeRisk } }),
          },
        ]);
        yield* editRiskPolicy(actors.admin, (tiers) => ({
          ...tiers,
          medium: { ...tiers.medium, approval: "ask" },
          high: { ...tiers.high, approval: "deny" },
        }));
        const call = yield* caller(actors.owner, path);

        // The build lists no tiers, so its tools list the tiers the policy enforces, from their
        // kinds and hints, in the full listing and in the index the Tools tab reads.
        const expected = { read: "low", write: "medium", erase: "high" };
        for (const listing of [`${path}/tools`, `${path}/tools/index`]) {
          const listed = yield* api.request(actors.owner, "GET", listing);
          expect(listed.status, JSON.stringify(listed.body)).toBe(200);
          expect(tiersOf(yield* body(Catalog, listed)), listing).toEqual(expected);
        }

        // The build cannot evaluate a tier, so Executor takes it from the tool's hints: a
        // destructive write is high, which the policy blocks.
        const erased = yield* call("erase", { id: "e1" });
        expect(erased.status, JSON.stringify(erased.body)).toBe(403);
        const blocked = yield* body(Blocked, erased);
        expect(blocked.message).toContain(
          "The organization’s risk policy blocks high-risk calls, so this call to “erase” did not run.",
        );

        // A write is medium, which the policy asks about. The build cannot ask, so the call is
        // refused, and the agent is told to redeploy the app rather than to wait for approval.
        const written = yield* call("write", { id: "w1" });
        expect(written.status, JSON.stringify(written.body)).toBe(403);
        const refused = yield* body(Blocked, written);
        expect(refused.message).toContain(
          "The organization’s risk policy requires a person to approve medium-risk calls to “write”, and the app’s current deployment cannot ask for approval.",
        );
        expect(refused.recovery.action).toBe(
          "Redeploy the app with a current apps release so the call can ask for approval, then call the tool again.",
        );

        // A read is low, which the policy leaves to the app.
        const read = yield* call("read", { id: "r1" });
        expect(read.status, JSON.stringify(read.body)).toBe(200);
        expect(read.body).toMatchObject({ read: "r1" });

        const logged = yield* loggedCallsWhen(app.id, (items) => items.length === 3);
        expect(
          logged
            .map((item) => [item.tool, item.status, item.errorType, item.risk, item.riskAction])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        ).toEqual([
          ["erase", "denied", "ToolBlocked", "high", "deny"],
          ["read", "succeeded", null, "low", null],
          ["write", "denied", "ToolBlocked", "medium", "ask"],
        ]);
      }),
    ),
  );

  it.effect(scenarios.toolRiskOpenapi.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const upstream = yield* recordsUpstream;
        const { app, path } = yield* deploy(
          "Risk records",
          openapiAppFiles("Risk records", {
            url: { document: recordsDocument },
            allowedOrigin: upstream.origin,
            baseUrl: upstream.origin,
            securitySchemes: {},
          }),
        );
        // A read is low, a delete high and any other write medium.
        const listed = yield* api.request(actors.owner, "GET", `${path}/tools`);
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        expect(tiersOf(yield* body(Catalog, listed))).toEqual({
          "records.getRecord": "low",
          "records.replaceRecord": "medium",
          "records.deleteRecord": "high",
        });

        yield* editRiskPolicy(actors.admin, (tiers) => ({
          ...tiers,
          high: { ...tiers.high, approval: "deny" },
        }));
        const call = yield* caller(actors.owner, path);
        // The delete is blocked before it reaches the API.
        const deleted = yield* call("records.deleteRecord", { path: { id: "r1" } });
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(403);
        expect((yield* body(Blocked, deleted)).message).toContain(
          "The organization’s risk policy blocks high-risk calls, so this call to “records.deleteRecord” did not run.",
        );
        expect(yield* upstream.seen).toEqual([]);
        // The read runs.
        const read = yield* call("records.getRecord", { path: { id: "r1" } });
        expect(read.status, JSON.stringify(read.body)).toBe(200);
        expect(yield* upstream.seen).toEqual(["GET /records/r1"]);

        const logged = yield* loggedCallsWhen(app.id, (items) => items.length === 2);
        expect(
          logged
            .map((item) => [item.tool, item.status, item.risk, item.riskAction])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        ).toEqual([
          ["records.deleteRecord", "denied", "high", "deny"],
          ["records.getRecord", "succeeded", "low", null],
        ]);
      }),
    ),
  );

  it.effect(scenarios.toolRiskApprovalRequired.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const { path } = yield* deployRiskApp;
        const call = yield* caller(actors.owner, path);
        // The app's own code decides an approval, and may write while it does, so a write that
        // needs approval keeps the warning that it may have made its change.
        const reviewed = yield* call("review", { id: "r1" });
        expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(409);
        expect(reviewed.body).toMatchObject({ mayHaveWritten: true });
        expect(reviewed.body).not.toHaveProperty("policy");
        expect((yield* body(ApprovalRequired, reviewed)).message).toContain(
          "“review” needs approval, and this request cannot present an approval prompt.",
        );
        // The default policy asks about critical calls: the refusal names the policy and tier.
        const wiped = yield* call("wipe", { id: "w1" });
        expect(wiped.status, JSON.stringify(wiped.body)).toBe(409);
        expect(wiped.body).toMatchObject({ mayHaveWritten: true, policy: true, risk: "critical" });
        expect((yield* body(ApprovalRequired, wiped)).message).toContain(
          "The organization’s risk policy requires approval for critical-risk tools, and this request cannot present an approval prompt.",
        );
      }),
    ),
  );
});
