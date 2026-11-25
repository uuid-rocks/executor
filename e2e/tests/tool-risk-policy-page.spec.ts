// JHPATCH: the Risk policy page and the Activity page's risk filter and recorded arguments.
/**
 * Owners and admins set what each risk tier does on the Risk policy page and give one tool its own
 * tier; members read the same page with every control disabled. Activity filters calls by tier and
 * shows a call's tier, what the policy did and its recorded arguments, secrets removed.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import type { Page } from "playwright";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { reveal, secret } from "../support/failure-text.ts";
import {
  defaultTiers,
  deployRiskApp,
  labelSecrets,
  readRiskPolicy,
  riskApiKey,
} from "../support/risk-policy.ts";

const Viewer = Schema.Struct({ user: Schema.Struct({ id: Schema.String, name: Schema.String }) });
const Calls = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Schema.String, tool: Schema.NullOr(Schema.String) })),
  total: Schema.Number,
});

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Choose `option` in the select named `name`, and wait for its list to close. */
const choose = (page: Page, name: string, option: string) =>
  page
    .getByRole("combobox", { name, exact: true })
    .click()
    .then(() => page.getByRole("option", { name: option, exact: true }).click())
    .then(() => page.getByRole("listbox").waitFor({ state: "hidden" }));
/** The text a select shows for its value. */
const shownChoice = (page: Page, name: string) =>
  page.getByRole("combobox", { name, exact: true }).innerText();
/** Every tier's approval select and record checkbox, as the page shows them. */
const tierControls = (page: Page) =>
  Promise.all(
    ["Low", "Medium", "High", "Critical"].map((tier) =>
      Promise.all([
        shownChoice(page, `Approval for ${tier}`),
        page
          .getByRole("checkbox", { name: `Record arguments for ${tier}`, exact: true })
          .isChecked(),
      ]),
    ),
  );

const summaryReads = (page: Page, text: string) =>
  page
    .getByRole("status")
    .filter({ hasText: new RegExp(`^${escaped(text)}$`, "u") })
    .first()
    .waitFor()
    .then(() => text);
const calls = (page: Page) => page.getByRole("list", { name: "Tool calls", exact: true });
const rows = (page: Page) => calls(page).locator("button[aria-expanded]");
/** The row of the call to `tool`, by its tool name alone: other text in a row can contain it. */
const rowOf = (page: Page, tool: string) =>
  rows(page).filter({ has: page.getByText(tool, { exact: true }) });
const detail = (page: Page, id: string) =>
  page.getByRole("region", { name: `Details of ${id}`, exact: true });

layer(HostedLive, { excludeTestServices: true })("Tool risk policy page", (it) => {
  it.effect(scenarios.toolRiskPolicyPage.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const { app } = yield* deployRiskApp;
        const admin = (yield* body(
          Viewer,
          yield* api.request(actors.admin, "GET", "/api/auth/get-session"),
        )).user;
        const slug = actors.organization.slug;
        yield* browser.login(actors.admin);
        yield* browser.use("Open the dashboard", (page) => page.goto(`/org/${slug}`));
        yield* browser.use("Open Risk policy from the sidebar", (page) =>
          page
            .getByRole("link", { name: "Risk policy", exact: true })
            .first()
            .click()
            .then(() =>
              page.getByRole("heading", { name: "Risk policy", level: 1, exact: true }).waitFor(),
            ),
        );
        // The defaults, before anyone changes them, and nothing to save.
        expect(
          yield* browser.use("Read the default tiers", (page) =>
            page
              .getByText("Defaults. No one has changed the policy.", { exact: true })
              .waitFor()
              .then(() =>
                Promise.all([
                  tierControls(page),
                  page.getByRole("button", { name: "Save", exact: true }).isDisabled(),
                  Promise.resolve(new URL(page.url()).pathname),
                ]),
              ),
          ),
        ).toEqual([
          [
            ["Use the app's approval", false],
            ["Use the app's approval", false],
            ["Use the app's approval", true],
            ["Always ask", true],
          ],
          true,
          `/org/${slug}/risk-policy`,
        ]);
        yield* browser.checkpoint("The default risk policy");

        // An edit can be discarded, which leaves nothing to save.
        yield* browser.use("Ask about every low call", (page) =>
          choose(page, "Approval for Low", "Always ask"),
        );
        expect(
          yield* browser.use("Discard the edit", (page) =>
            page
              .getByRole("button", { name: "Discard changes", exact: true })
              .click()
              .then(() =>
                Promise.all([
                  shownChoice(page, "Approval for Low"),
                  page.getByRole("button", { name: "Save", exact: true }).isDisabled(),
                ]),
              ),
          ),
        ).toEqual(["Use the app's approval", true]);

        // Block high calls and record medium ones, then save.
        yield* browser.use("Block high calls", (page) =>
          choose(page, "Approval for High", "Block"),
        );
        yield* browser.use("Record medium calls' arguments", (page) =>
          page.getByRole("checkbox", { name: "Record arguments for Medium", exact: true }).click(),
        );
        yield* browser.use("Save the policy", (page) =>
          page
            .getByRole("button", { name: "Save", exact: true })
            .click()
            .then(() =>
              page
                .getByRole("status")
                .filter({ hasText: /^Saved$/u })
                .waitFor(),
            ),
        );
        yield* browser.checkpoint("The saved policy");
        // The product keeps exactly that edit, by the admin who made it.
        const saved = yield* readRiskPolicy(actors.owner);
        expect(saved.tiers).toEqual({
          ...defaultTiers,
          medium: { approval: "app", recordArguments: true },
          high: { approval: "deny", recordArguments: true },
        });
        expect(saved.updatedBy).toEqual({ id: admin.id, name: admin.name });
        // A reload reads the saved policy and who changed it.
        expect(
          yield* browser.use("Reload the page", (page) =>
            page
              .reload()
              .then(() =>
                page.getByText(new RegExp(`^Changed by ${escaped(admin.name)} `, "u")).waitFor(),
              )
              .then(() => tierControls(page)),
          ),
        ).toEqual([
          ["Use the app's approval", false],
          ["Use the app's approval", true],
          ["Block", true],
          ["Always ask", true],
        ]);

        // A tool override: choose the app, then one of its tools, then the tier.
        yield* browser.use("Choose the app", (page) => choose(page, "App", app.name));
        yield* browser.use("Choose the tool", (page) => choose(page, "Tool", "erase"));
        yield* browser.use("Choose the tier", (page) => choose(page, "Tier", "Critical"));
        const added = yield* browser.use("Add the override", (page) =>
          page
            .getByRole("button", { name: "Add override", exact: true })
            .click()
            .then(() =>
              page
                .getByRole("form", { name: "Add override", exact: true })
                .getByRole("status")
                .filter({ hasText: /^Override saved$/u })
                .waitFor(),
            )
            .then(() =>
              page.getByRole("list", { name: "Tool overrides", exact: true }).innerText(),
            ),
        );
        expect(added).toContain("erase");
        expect(added).toContain(app.name);
        expect(added).toContain("Critical");
        expect((yield* readRiskPolicy(actors.owner)).overrides).toMatchObject([
          { app: { id: app.id }, tool: "erase", risk: "critical", setBy: { id: admin.id } },
        ]);
        yield* browser.checkpoint("A tool override");

        // The member reads the same policy, override included, and can change none of it.
        yield* browser.login(actors.member);
        const memberView = yield* browser.use("Open the page as a member", (page) =>
          page
            .goto(`/org/${slug}/risk-policy`)
            .then(() => page.getByRole("list", { name: "Tool overrides", exact: true }).waitFor())
            .then(() =>
              Promise.all([
                tierControls(page),
                Promise.all(
                  [
                    page.getByRole("combobox", { name: "Approval for High", exact: true }),
                    page.getByRole("checkbox", { name: "Record arguments for High", exact: true }),
                    page.getByRole("button", { name: "Save", exact: true }),
                    page.getByRole("combobox", { name: "App", exact: true }),
                    page.getByRole("button", { name: "Add override", exact: true }),
                    page.getByRole("button", { name: "Remove override for erase", exact: true }),
                  ].map((control) => control.isDisabled()),
                ),
              ]),
            ),
        );
        expect(memberView).toEqual([
          [
            ["Use the app's approval", false],
            ["Use the app's approval", true],
            ["Block", true],
            ["Always ask", true],
          ],
          [true, true, true, true, true, true],
        ]);
        yield* browser.checkpoint("The policy as a member reads it");

        // Back as the admin, removing the override leaves none.
        yield* browser.login(actors.admin);
        yield* browser.use("Remove the override", (page) =>
          page
            .goto(`/org/${slug}/risk-policy`)
            .then(() =>
              page.getByRole("button", { name: "Remove override for erase", exact: true }).click(),
            )
            .then(() => page.getByText("No overrides.", { exact: true }).waitFor()),
        );
        expect((yield* readRiskPolicy(actors.owner)).overrides).toEqual([]);
      }),
    ),
  );

  it.effect(scenarios.toolRiskActivity.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const { app, path, prefix } = yield* deployRiskApp;
        const key = yield* riskApiKey(actors.owner, `Activity risk ${randomUUID().slice(0, 6)}`);
        const agent = yield* api.session();
        const call = (tool: string, input: Record<string, unknown>) =>
          api.request(agent, "POST", `${path}/tools/call`, { tool, input }, key.bearer);
        // Registered as secrets, so a failure that echoes them masks them.
        const password = reveal(secret(`pw-${randomUUID()}`));
        const stripeKey = reveal(secret(`sk_live_${randomUUID().replaceAll("-", "")}`));
        expect((yield* call("read", { id: "low-read" })).status).toBe(200);
        const archived = yield* call("archive", {
          id: "box-9",
          password,
          note: stripeKey,
          options: { apiKey: "plain", label: "kept label" },
          memo: "m".repeat(3000),
        });
        expect(archived.status, JSON.stringify(archived.body)).toBe(200);
        // The default policy asks about critical calls, which an API caller cannot answer.
        expect((yield* call("wipe", { id: "all" })).status).toBe(409);
        const logged = yield* api
          .request(actors.admin, "GET", `${prefix}/tool-calls?app=${app.id}&range=24h`)
          .pipe(
            Effect.flatMap((response) => body(Calls, response)),
            Effect.repeat({
              until: ({ total }) => total >= 3,
              schedule: Schedule.spaced("100 millis"),
            }),
            Effect.timeout("10 seconds"),
          );
        const idOf = (tool: string) => logged.items.find((item) => item.tool === tool)?.id ?? "";

        yield* browser.login(actors.admin);
        yield* browser.use("Open Activity", (page) =>
          page.goto(`/org/${actors.organization.slug}/activity`),
        );
        yield* browser.use("Every call is listed", (page) =>
          summaryReads(page, "3 tool calls in the last 7 days"),
        );
        yield* browser.use("Filter to high risk and above", (page) =>
          page
            .getByRole("button", { name: /^Filter/u })
            .click()
            .then(() =>
              page
                .getByRole("group", { name: "Filters" })
                .getByRole("menuitem", { name: /^Risk/u })
                .click(),
            )
            .then(() =>
              page.getByRole("menuitemradio", { name: "High and above", exact: true }).click(),
            )
            .then(() => page.keyboard.press("Escape")),
        );
        const filtered = yield* browser.use("Only high and critical calls are listed", (page) =>
          summaryReads(page, "2 tool calls in the last 7 days").then(() =>
            Promise.all([
              rows(page).allInnerTexts(),
              page
                .getByRole("button", { name: "Remove filter Risk: High and above", exact: true })
                .count(),
              Promise.resolve(new URL(page.url()).searchParams.get("risk")),
            ]),
          ),
        );
        // Each row names its tier.
        expect(filtered[0].map((text) => /\b(\w+) risk\b/u.exec(text)?.[1]).sort()).toEqual([
          "critical",
          "high",
        ]);
        expect(filtered.slice(1)).toEqual([1, "high"]);
        yield* browser.checkpoint("High-risk calls");

        // The recorded call's details give its tier and its arguments, secrets removed and the
        // long memo cut.
        const archiveId = idOf("archive");
        const archiveDetail = yield* browser.use("Open the archive call", (page) =>
          rowOf(page, "archive")
            .click()
            .then(() => detail(page, archiveId).waitFor())
            .then(() =>
              Promise.all([
                detail(page, archiveId).locator("dt:has-text('Risk') + dd").innerText(),
                detail(page, archiveId).getByLabel("Arguments", { exact: true }).innerText(),
                detail(page, archiveId)
                  .getByText("Some values were too long to keep and were cut short.", {
                    exact: true,
                  })
                  .count(),
                detail(page, archiveId).innerText(),
              ]),
            ),
        );
        expect(archiveDetail[0]).toBe("High");
        expect(
          labelSecrets(JSON.parse(archiveDetail[1]), {
            [password]: "<password>",
            [stripeKey]: "<stripe key>",
          }),
        ).toEqual({
          id: "box-9",
          password: "[redacted]",
          note: "[redacted]",
          options: { apiKey: "[redacted]", label: "kept label" },
          memo: "m".repeat(2048),
        });
        expect(archiveDetail[2]).toBe(1);
        for (const value of [password, stripeKey])
          expect(archiveDetail[3].includes(value)).toBe(false);
        yield* browser.checkpoint("A recorded call's arguments");

        // The critical call says the policy asked for approval.
        const wipeId = idOf("wipe");
        expect(
          yield* browser.use("Open the critical call", (page) =>
            rowOf(page, "wipe")
              .click()
              .then(() => detail(page, wipeId).waitFor())
              .then(() => detail(page, wipeId).locator("dt:has-text('Risk') + dd").innerText()),
          ),
        ).toBe("Critical\nAsked by risk policy");

        // A low call, whose tier the policy does not record, shows no arguments.
        const readId = idOf("read");
        expect(
          yield* browser.use("Open the low call without the filter", (page) =>
            page
              .getByRole("button", { name: "Remove filter Risk: High and above", exact: true })
              .click()
              .then(() => summaryReads(page, "3 tool calls in the last 7 days"))
              .then(() => rowOf(page, "read").click())
              .then(() => detail(page, readId).waitFor())
              .then(() =>
                Promise.all([
                  detail(page, readId).locator("dt:has-text('Risk') + dd").innerText(),
                  detail(page, readId).getByLabel("Arguments", { exact: true }).count(),
                ]),
              ),
          ),
        ).toEqual(["Low", 0]);
      }),
    ),
  );
});
