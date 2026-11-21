// JHPATCH: the tool call log's risk tiers, risk filters and recorded arguments.
/**
 * The tool call log records the risk tier each call was evaluated at and whether the risk policy
 * asked for approval or blocked it, and filters by tier, kind and whether approval was asked. For
 * a tier whose policy records arguments it keeps the call's arguments, secrets removed, shown to
 * owners, admins and the member who made the call; for any other tier it keeps none.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { reveal, secret } from "../support/failure-text.ts";
import { deployRiskApp, editRiskPolicy, labelSecrets, riskApiKey } from "../support/risk-policy.ts";

const Call = Schema.Struct({
  id: Schema.String,
  tool: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(Schema.String),
  status: Schema.String,
  errorType: Schema.NullOr(Schema.String),
  risk: Schema.NullOr(Schema.String),
  riskAction: Schema.NullOr(Schema.String),
  arguments: Schema.NullOr(Schema.Struct({ value: Schema.Unknown, truncated: Schema.Boolean })),
});
type Call = typeof Call.Type;
const Page = Schema.Struct({ items: Schema.Array(Call), total: Schema.Number });
const Failure = Schema.Struct({ _tag: Schema.String, reference: Schema.optional(Schema.String) });
const Pending = Schema.Struct({ status: Schema.Literal("approval-required") });

/** The log's page for `query`, as `actor` reads it, with the raw body for privacy checks. */
const readLog = (actor: Session, query: Record<string, string>) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const response = yield* api.request(
      actor,
      "GET",
      `/api/organizations/${actors.organization.id}/tool-calls?${new URLSearchParams(query)}`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return { page: yield* body(Page, response), raw: JSON.stringify(response.body) };
  });
/** A call that succeeded is written after its response, so its row can arrive a moment later. */
const readLogWhen = (actor: Session, query: Record<string, string>, total: number) =>
  readLog(actor, query).pipe(
    Effect.repeat({
      until: ({ page }) => page.total >= total,
      schedule: Schedule.spaced("100 millis"),
    }),
    Effect.timeout("10 seconds"),
  );
/** Each call's tool, sorted, so a filter's result reads as the set of tools it kept. */
const toolsOf = (items: ReadonlyArray<Call>) => items.map((item) => item.tool ?? "").sort();

/** The risk app, an API key for `actor` and a call through it. */
const caller = (actor: Session, path: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const key = yield* riskApiKey(actor, `Risk log ${randomUUID().slice(0, 6)}`);
    const agent = yield* api.session();
    return (tool: string, input: Record<string, unknown>) =>
      api.request(agent, "POST", `${path}/tools/call`, { tool, input }, key.bearer);
  });

layer(HostedLive, { excludeTestServices: true })("Tool risk log", (it) => {
  it.effect(scenarios.toolRiskLogFilters.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const { app, path } = yield* deployRiskApp;
        const call = yield* caller(actors.owner, path);
        for (const tool of ["read", "write", "erase"]) {
          const response = yield* call(tool, { id: tool });
          expect(response.status, `${tool}: ${JSON.stringify(response.body)}`).toBe(200);
        }
        // The default policy asks about critical calls; an API caller cannot answer, so the call
        // is refused as needing approval.
        const wiped = yield* call("wipe", { id: "wipe" });
        expect(wiped.status, JSON.stringify(wiped.body)).toBe(409);
        expect((yield* body(Failure, wiped))._tag).toBe("ToolApprovalRequired");
        // The app itself asks about `review`; the dashboard's run waits for its answer.
        yield* api
          .request(actors.owner, "POST", `${path}/tools/run`, {
            tool: "review",
            kind: "mutation",
            input: { id: "review" },
          })
          .pipe(Effect.flatMap((response) => body(Pending, response)));

        const all = yield* readLogWhen(actors.admin, { app: app.id, range: "24h" }, 5);
        expect(
          all.page.items
            .map((item) => [item.tool, item.kind, item.risk, item.riskAction])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        ).toEqual([
          ["erase", "mutation", "high", null],
          ["read", "query", "low", null],
          ["review", "mutation", "medium", null],
          ["wipe", "mutation", "critical", "ask"],
          ["write", "mutation", "medium", null],
        ]);

        // A tier keeps calls at it and above.
        const filtered = (query: Record<string, string>) =>
          readLog(actors.admin, { app: app.id, range: "24h", ...query }).pipe(
            Effect.map(({ page }) => toolsOf(page.items)),
          );
        expect(yield* filtered({ risk: "high" })).toEqual(["erase", "wipe"]);
        expect(yield* filtered({ risk: "critical" })).toEqual(["wipe"]);
        expect(yield* filtered({ risk: "medium" })).toEqual(["erase", "review", "wipe", "write"]);
        expect(yield* filtered({ risk: "low" })).toEqual(toolsOf(all.page.items));
        // Kind keeps reads or writes.
        expect(yield* filtered({ kind: "query" })).toEqual(["read"]);
        expect(yield* filtered({ kind: "mutation" })).toEqual(["erase", "review", "wipe", "write"]);
        // Approval keeps calls that asked a person, whether the policy or the app asked, or those
        // that did not.
        expect(yield* filtered({ approval: "requested" })).toEqual(["review", "wipe"]);
        expect(yield* filtered({ approval: "none" })).toEqual(["erase", "read", "write"]);
        // Filters combine.
        expect(yield* filtered({ risk: "high", approval: "none" })).toEqual(["erase"]);
        // A tier that is not one is refused, not read as no filter.
        const invalid = yield* api.request(
          actors.admin,
          "GET",
          `/api/organizations/${actors.organization.id}/tool-calls?risk=severe`,
        );
        expect(invalid.status, JSON.stringify(invalid.body)).toBe(400);
      }),
    ),
  );

  it.effect(scenarios.toolRiskLogArguments.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const { app, path } = yield* deployRiskApp;
        // Registered as secrets, so a failure that echoes them masks them.
        const password = reveal(secret(`pw-${randomUUID()}`));
        const stripeKey = reveal(secret(`sk_live_${randomUUID().replaceAll("-", "")}`));
        const apiKey = reveal(secret(`key-${randomUUID()}`));
        const memberPassword = reveal(secret(`pw-${randomUUID()}`));
        const secrets = [password, stripeKey, apiKey, memberPassword];
        const labels = {
          [password]: "<password>",
          [stripeKey]: "<stripe key>",
          [apiKey]: "<api key>",
          [memberPassword]: "<member password>",
        };
        const archived = (id: string, secretValue: string, memo: string) => ({
          id,
          password: secretValue,
          note: stripeKey,
          options: { apiKey, label: "kept label" },
          memo,
        });

        // `archive` is high, which the default policy records; its memo is past the 2,048
        // characters a recorded string keeps.
        const ownerCall = yield* caller(actors.owner, path);
        const longMemo = "m".repeat(3000);
        const ran = yield* ownerCall("archive", archived("box-1", password, longMemo));
        expect(ran.status, JSON.stringify(ran.body)).toBe(200);
        // `read` is low, which the default policy does not record.
        const lowMarker = `low-${randomUUID()}`;
        expect((yield* ownerCall("read", { id: lowMarker })).status).toBe(200);
        const ownerRows = yield* readLogWhen(actors.admin, { app: app.id, range: "24h" }, 2);
        const ownerArchive = ownerRows.page.items.find((item) => item.tool === "archive");
        // A key that names a secret and a value shaped like a credential are replaced, at any
        // depth; other values are kept, the long one cut.
        expect(labelSecrets(ownerArchive?.arguments, labels)).toEqual({
          value: {
            id: "box-1",
            password: "[redacted]",
            note: "[redacted]",
            options: { apiKey: "[redacted]", label: "kept label" },
            memo: "m".repeat(2048),
          },
          truncated: true,
        });
        expect(ownerRows.page.items.find((item) => item.tool === "read")).toMatchObject({
          risk: "low",
          arguments: null,
        });
        expect(ownerRows.raw).not.toContain(lowMarker);

        // The member's own call: they read its arguments, as owners and admins do.
        const memberCall = yield* caller(actors.member, path);
        const memberRan = yield* memberCall("archive", archived("box-2", memberPassword, "short"));
        expect(memberRan.status, JSON.stringify(memberRan.body)).toBe(200);
        const memberRows = yield* readLogWhen(
          actors.member,
          { app: app.id, range: "24h", tool: "archive" },
          1,
        );
        expect(
          labelSecrets(
            memberRows.page.items.map((item) => item.arguments),
            labels,
          ),
        ).toEqual([
          {
            value: {
              id: "box-2",
              password: "[redacted]",
              note: "[redacted]",
              options: { apiKey: "[redacted]", label: "kept label" },
              memo: "short",
            },
            truncated: false,
          },
        ]);
        // The owner's call, arguments and all, is not the member's to read.
        const ownerReference = ownerArchive?.id ?? "";
        expect((yield* readLog(actors.member, { search: ownerReference })).page.total).toBe(0);
        expect(memberRows.raw).not.toContain("box-1");
        const adminRows = yield* readLogWhen(
          actors.admin,
          { app: app.id, range: "24h", tool: "archive" },
          2,
        );
        expect(
          adminRows.page.items
            .map((item) => (item.arguments?.value as { id?: string } | undefined)?.id)
            .sort(),
        ).toEqual(["box-1", "box-2"]);

        // The policy, not the tier alone, decides: recording low calls keeps the next read's.
        yield* editRiskPolicy(actors.admin, (tiers) => ({
          ...tiers,
          low: { ...tiers.low, recordArguments: true },
        }));
        expect((yield* ownerCall("read", { id: "recorded-read" })).status).toBe(200);
        const reads = yield* readLogWhen(
          actors.admin,
          { app: app.id, range: "24h", tool: "read" },
          2,
        );
        expect(reads.page.items.map((item) => item.arguments)).toEqual([
          { value: { id: "recorded-read" }, truncated: false },
          null,
        ]);

        // No secret reaches the log in any form.
        for (const raw of [ownerRows.raw, memberRows.raw, adminRows.raw, reads.raw])
          for (const value of secrets) expect(raw.includes(value)).toBe(false);
      }),
    ),
  );
});
