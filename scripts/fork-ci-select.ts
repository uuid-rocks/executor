// JHPATCH: the fork's CI has no upstream select job; this picks each E2E job's scenarios.
/**
 * Print each E2E job's `--test-name` pattern for the fork's CI (.github/workflows/ci.yml), one
 * `<target>=<pattern>` line per target, empty when the job has nothing to run.
 *
 * The scenarios are those of the spec files named in the pull request description's `e2e` block
 * (`E2E_BODY`) or the manual run's `E2E_SPECS`, plus every spec file the change touches
 * (`E2E_CHANGED`, newline-separated paths). `all` runs every scheduled scenario.
 */
import { scenarios } from "../e2e/test-plan.ts";
import { parseRequested } from "../e2e/ci-block.ts";

const targets = ["self-host", "cloud"] as const;

const requested = process.env.E2E_SPECS?.trim()
  ? parseRequested(`\`\`\`e2e\n${process.env.E2E_SPECS}\n\`\`\`\n`)
  : parseRequested(process.env.E2E_BODY ?? "");
if (requested._tag !== "Named" && requested._tag !== "All")
  throw new Error(
    `The pull request description needs exactly one \`\`\`e2e block naming spec files, \`none\`, or \`all: <reason>\` (found ${requested._tag}).`,
  );

const changed = (process.env.E2E_CHANGED ?? "")
  .split("\n")
  .map((path) => /^e2e\/tests\/(.+\.spec\.ts)$/.exec(path.trim())?.[1])
  .filter((file) => file !== undefined);
const files = new Set([
  ...(requested._tag === "Named"
    ? requested.tokens.map((t) => t.replace(/^e2e\/tests\//, ""))
    : []),
  ...changed,
]);
const known = new Set(Object.values(scenarios).map((scenario) => scenario.file));
const unknown = [...files].filter((file) => !known.has(file));
if (unknown.length > 0) throw new Error(`No scheduled scenarios in: ${unknown.join(", ")}`);

const escape = (title: string) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const selected = (target: (typeof targets)[number]) =>
  Object.values(scenarios).filter((scenario) => {
    const plan: { readonly status: string; readonly runtime?: string } = scenario.targets[target];
    // Other Cloud runtimes need a deployed stage or their own flags; the fork's CI runs plain
    // managed local Cloud only.
    const runnable = target !== "cloud" || plan.runtime === undefined || plan.runtime === "managed";
    return (
      plan.status === "scheduled" &&
      runnable &&
      (requested._tag === "All" || files.has(scenario.file))
    );
  });
const patternOf = (titles: ReadonlyArray<string>) =>
  requested._tag === "All" ? "." : `^(?:${titles.map(escape).join("|")})$`;

const selfHost = selected("self-host").map((scenario) => scenario.title);
console.log(`self-host=${selfHost.length === 0 ? "" : patternOf(selfHost)}`);

// Some Cloud scenarios lock tables or count every request in the shared local Cloud, so each spec
// file gets a local Cloud of its own, run one after another (a JSON array of patterns).
const cloudFiles = new Map<string, Array<string>>();
for (const scenario of selected("cloud"))
  cloudFiles.set(scenario.file, [...(cloudFiles.get(scenario.file) ?? []), scenario.title]);
const cloud =
  cloudFiles.size === 0
    ? []
    : requested._tag === "All"
      ? ["."]
      : [...cloudFiles.values()].map(patternOf);
console.log(`cloud=${cloud.length === 0 ? "" : JSON.stringify(cloud)}`);
