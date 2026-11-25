// JHPATCH: the organization's risk policy page
/**
 * The organization's risk policy: how calls at each risk tier are approved and whether their
 * arguments are kept, and the tools whose tier an administrator set. Every member may read it;
 * owners and admins change it.
 */
import { useId, useState } from "react";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause, Exit, Option, Schema } from "effect";
import {
  ToolName,
  type App,
  type AppId,
  type RiskAction,
  type RiskTier,
  type VersionId,
} from "@executor-js/sdk";
import type { RiskPolicy } from "@executor-js/hosted-server/risk-policy";
import { Button } from "@executor-js/ui/components/button";
import { Checkbox } from "@executor-js/ui/components/checkbox";
import { Input } from "@executor-js/ui/components/input";
import { Label } from "@executor-js/ui/components/label";
import { LocalTime, shortMoment } from "@executor-js/ui/components/local-time";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor-js/ui/components/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@executor-js/ui/components/card";
import { usePreload } from "@executor-js/ui/dashboard/context";
import { productTitle, useDocumentTitle } from "@executor-js/ui/hooks/document-title";
import { appError } from "../../contracts/errors.ts";
import { toolsAtom } from "../../contracts/apps.ts";
import { inventoryAtom } from "../../contracts/organization.ts";
import {
  removeRiskOverrideAtom,
  riskPolicyAtom,
  setRiskOverrideAtom,
  updateRiskPolicyAtom,
} from "../../contracts/risk-policy.ts";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { type OrganizationPageReads, useOrganizationRoute } from "../components/organization.tsx";
import {
  RiskPolicyFrame,
  RiskPolicyLoading,
  riskPolicyTitle,
} from "../components/page-pending.tsx";

export const riskPolicyPageReads: OrganizationPageReads = (organization) => [
  riskPolicyAtom(organization),
];

const tiers: readonly RiskTier[] = ["low", "medium", "high", "critical"];
const tierNames: Record<RiskTier, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};
const tierDescriptions: Record<RiskTier, string> = {
  low: "Reads, or changes nothing that matters.",
  medium: "Ordinary writes.",
  high: "Hard to undo, such as deletes.",
  critical: "Production changes, money or bulk actions.",
};
const actions: readonly RiskAction[] = ["app", "ask", "deny"];
const actionNames: Record<RiskAction, string> = {
  app: "Use the app's approval",
  ask: "Always ask",
  deny: "Block",
};
const readOnlyReason = "Only organization owners and admins can change the risk policy.";

type Tiers = RiskPolicy["tiers"];
type Person = NonNullable<RiskPolicy["updatedBy"]>;
const personName = (person: Person) => person.name ?? "A former member";

export function RiskPolicyPage() {
  const { organization, role } = useOrganizationRoute();
  usePreload(...riskPolicyPageReads(organization, {}));
  useDocumentTitle(productTitle(riskPolicyTitle));
  const result = useAtomValue(riskPolicyAtom(organization));
  const refresh = useAtomRefresh(riskPolicyAtom(organization));
  const policy = AsyncResult.value(result);
  const readOnly = role === "owner" || role === "admin" ? undefined : readOnlyReason;
  return (
    <RiskPolicyFrame>
      {AsyncResult.isFailure(result) && <HostedFailure cause={result.cause} retry={refresh} />}
      {Option.isSome(policy) ? (
        <div key={organization} className="flex flex-col gap-4">
          <TierSettings policy={policy.value} readOnly={readOnly} />
          <Overrides policy={policy.value} readOnly={readOnly} />
        </div>
      ) : (
        !AsyncResult.isFailure(result) && <RiskPolicyLoading />
      )}
    </RiskPolicyFrame>
  );
}

const sameTiers = (a: Tiers, b: Tiers) =>
  tiers.every(
    (tier) =>
      a[tier].approval === b[tier].approval && a[tier].recordArguments === b[tier].recordArguments,
  );

function TierSettings({
  policy,
  readOnly,
}: {
  readonly policy: RiskPolicy;
  readonly readOnly: string | undefined;
}) {
  const { organization } = useOrganizationRoute();
  const update = useAtomSet(updateRiskPolicyAtom(organization), { mode: "promiseExit" });
  const state = useAtomValue(updateRiskPolicyAtom(organization));
  /** Edits and the revision they were made from; a newer policy elsewhere refuses the save. */
  const [draft, setDraft] = useState<{ readonly revision: string; readonly tiers: Tiers }>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const shown = draft?.tiers ?? policy.tiers;
  const changed = draft !== undefined && !sameTiers(draft.tiers, policy.tiers);
  const edit = (tier: RiskTier, next: Partial<Tiers[RiskTier]>) => {
    setDraft({
      revision: draft?.revision ?? policy.revision,
      tiers: { ...shown, [tier]: { ...shown[tier], ...next } },
    });
    setSaved(false);
    setError(undefined);
  };
  return (
    <Card asChild className="gap-0 py-0">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (draft === undefined || readOnly !== undefined) return;
          setError(undefined);
          setSaved(false);
          const result = await update(draft);
          if (Exit.isSuccess(result)) {
            setDraft(undefined);
            setSaved(true);
            return;
          }
          const failure = Cause.findErrorOption(result.cause);
          if (Option.isSome(failure) && failure.value._tag === "AccessConflict") {
            // The latest policy is read again; edits made on an older one would undo its changes.
            setDraft(undefined);
            setError(
              "Someone else changed the policy, so your changes were not saved. The latest policy is shown.",
            );
          } else setError(appError(result.cause));
        }}
      >
        <CardHeader className="gap-1.5 px-4 pt-4 pb-3">
          <CardTitle>
            <h2>Tiers</h2>
          </CardTitle>
          <CardDescription>
            A tier can require a person to approve its calls or block them, even when the app would
            not ask. Recorded arguments appear in Activity, with secrets removed.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <table className="w-full text-[13px]">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="pb-2 font-normal">Tier</th>
                <th className="pb-2 font-normal">Approval</th>
                <th className="pb-2 text-right font-normal">Record arguments</th>
              </tr>
            </thead>
            <tbody className="divide-y border-t">
              {tiers.map((tier) => (
                <tr key={tier}>
                  <td className="py-3 pr-3 align-middle">
                    <span className="block font-medium">{tierNames[tier]}</span>
                    <span className="block text-xs text-muted-foreground">
                      {tierDescriptions[tier]}
                    </span>
                  </td>
                  <td className="py-3 pr-3 align-middle">
                    <Select
                      value={shown[tier].approval}
                      disabled={readOnly !== undefined}
                      onValueChange={(value) => {
                        const approval = actions.find((action) => action === value);
                        if (approval !== undefined) edit(tier, { approval });
                      }}
                    >
                      <SelectTrigger
                        aria-label={`Approval for ${tierNames[tier]}`}
                        className="w-52 max-w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {actions.map((action) => (
                          <SelectItem key={action} value={action}>
                            {actionNames[action]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="py-3 text-right align-middle">
                    <Checkbox
                      aria-label={`Record arguments for ${tierNames[tier]}`}
                      checked={shown[tier].recordArguments}
                      disabled={readOnly !== undefined}
                      onCheckedChange={(checked) =>
                        edit(tier, { recordArguments: checked === true })
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {error && (
            <p role="alert" className="mt-3 text-[13px] text-destructive">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          <p>
            {policy.updatedAt === null ? (
              "Defaults. No one has changed the policy."
            ) : (
              <>
                Changed
                {policy.updatedBy !== null && ` by ${personName(policy.updatedBy)}`}{" "}
                <LocalTime value={policy.updatedAt} options={shortMoment} />
              </>
            )}
          </p>
          <div className="flex items-center gap-3">
            {saved && <span role="status">Saved</span>}
            {changed && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(undefined)}>
                Discard changes
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              loading={state.waiting}
              disabled={!changed}
              disabledReason={readOnly}
            >
              Save
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}

function Overrides({
  policy,
  readOnly,
}: {
  readonly policy: RiskPolicy;
  readonly readOnly: string | undefined;
}) {
  const { organization } = useOrganizationRoute();
  const remove = useAtomSet(removeRiskOverrideAtom(organization), { mode: "promiseExit" });
  const removal = useAtomValue(removeRiskOverrideAtom(organization));
  const [removing, setRemoving] = useState<string>();
  const [error, setError] = useState<string>();
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="gap-1.5 px-4 pt-4 pb-3">
        <CardTitle>
          <h2>Tool overrides</h2>
        </CardTitle>
        <CardDescription>
          A tool given a tier here is evaluated at it, whatever its app declares.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {policy.overrides.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No overrides.</p>
        ) : (
          <ul aria-label="Tool overrides" className="divide-y rounded-md border">
            {policy.overrides.map((override) => {
              const key = `${override.app.id}:${override.tool}`;
              return (
                <li key={key} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-[13px]">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono">{override.tool}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {override.app.name ?? "An app you can no longer use"}
                      {override.setBy !== null && ` · Set by ${personName(override.setBy)}`}
                    </span>
                  </span>
                  <span className="w-20 font-medium">{tierNames[override.risk]}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Remove override for ${override.tool}`}
                    loading={removal.waiting && removing === key}
                    disabled={removal.waiting}
                    disabledReason={readOnly}
                    onClick={async () => {
                      setRemoving(key);
                      setError(undefined);
                      const result = await remove({ app: override.app.id, tool: override.tool });
                      if (Exit.isFailure(result)) setError(appError(result.cause));
                    }}
                  >
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {error && (
          <p role="alert" className="mt-3 text-[13px] text-destructive">
            {error}
          </p>
        )}
        <AddOverride readOnly={readOnly} />
      </CardContent>
    </Card>
  );
}

function AddOverride({ readOnly }: { readonly readOnly: string | undefined }) {
  const { organization } = useOrganizationRoute();
  const ids = { app: useId(), tool: useId(), tier: useId() };
  const inventory = useAtomValue(inventoryAtom(organization));
  const apps = Option.match(AsyncResult.value(inventory), {
    onNone: () => [],
    // Only a deployed version lists tools to choose from.
    onSome: (value) => value.apps.filter((app) => app.activeVersion !== null),
  });
  const save = useAtomSet(setRiskOverrideAtom(organization), { mode: "promiseExit" });
  const state = useAtomValue(setRiskOverrideAtom(organization));
  const [app, setApp] = useState<App>();
  const [tool, setTool] = useState<ToolName>();
  const [tier, setTier] = useState<RiskTier>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const disabled = readOnly !== undefined;
  return (
    <form
      aria-label="Add override"
      className="mt-4 grid gap-3 border-t pt-4 min-[740px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem_auto] min-[740px]:items-end"
      onSubmit={async (event) => {
        event.preventDefault();
        if (disabled || app === undefined || tool === undefined || tier === undefined) return;
        setError(undefined);
        setSaved(false);
        const result = await save({ app: app.id, tool, risk: tier });
        if (Exit.isFailure(result)) setError(appError(result.cause));
        else {
          setTool(undefined);
          setTier(undefined);
          setSaved(true);
        }
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={ids.app}>App</Label>
        <Select
          value={app?.id ?? ""}
          disabled={disabled || apps.length === 0}
          onValueChange={(value) => {
            setApp(apps.find((each) => each.id === value));
            setTool(undefined);
            setSaved(false);
          }}
        >
          <SelectTrigger id={ids.app} className="w-full">
            <SelectValue
              placeholder={AsyncResult.isInitial(inventory) ? "Loading apps…" : "Choose an app"}
            />
          </SelectTrigger>
          <SelectContent>
            {apps.map((each) => (
              <SelectItem key={each.id} value={each.id}>
                {each.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={ids.tool}>Tool</Label>
        {app === undefined ? (
          <Select disabled>
            <SelectTrigger id={ids.tool} className="w-full">
              <SelectValue placeholder="Choose an app first" />
            </SelectTrigger>
          </Select>
        ) : (
          <ToolChoice
            key={app.id}
            id={ids.tool}
            app={app.id}
            version={app.activeVersion ?? undefined}
            value={tool}
            disabled={disabled}
            onChange={(next) => {
              setTool(next);
              setSaved(false);
            }}
          />
        )}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={ids.tier}>Tier</Label>
        <Select
          value={tier ?? ""}
          disabled={disabled}
          onValueChange={(value) => {
            setTier(tiers.find((each) => each === value));
            setSaved(false);
          }}
        >
          <SelectTrigger id={ids.tier} className="w-full">
            <SelectValue placeholder="Choose a tier" />
          </SelectTrigger>
          <SelectContent>
            {tiers.map((each) => (
              <SelectItem key={each} value={each}>
                {tierNames[each]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button
        variant="outline"
        loading={state.waiting}
        disabled={app === undefined || tool === undefined || tier === undefined}
        disabledReason={readOnly}
      >
        Add override
      </Button>
      {(error !== undefined || saved) && (
        <p
          role={error === undefined ? "status" : "alert"}
          className={`text-[13px] min-[740px]:col-span-4 ${error === undefined ? "text-muted-foreground" : "text-destructive"}`}
        >
          {error ?? "Override saved"}
        </p>
      )}
    </form>
  );
}

/**
 * The app's tools to choose from. An app may list nothing without linked accounts, so when its
 * listing fails the name is typed instead.
 */
function ToolChoice({
  id,
  app,
  version,
  value,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly app: AppId;
  readonly version: VersionId | undefined;
  readonly value: ToolName | undefined;
  readonly disabled: boolean;
  readonly onChange: (tool: ToolName | undefined) => void;
}) {
  const { organization } = useOrganizationRoute();
  const result = useAtomValue(toolsAtom({ organization, app, version }));
  const listing = AsyncResult.value(result);
  if (AsyncResult.isFailure(result) && Option.isNone(listing))
    return (
      <>
        <Input
          id={id}
          value={value ?? ""}
          disabled={disabled}
          placeholder="Tool name"
          className="font-mono"
          onChange={(event) =>
            onChange(
              Option.getOrUndefined(
                Schema.decodeUnknownOption(ToolName)(event.target.value.trim()),
              ),
            )
          }
        />
        <span className="text-xs text-muted-foreground">
          The app's tools could not be listed. Type the tool's name.
        </span>
      </>
    );
  const tools = Option.match(listing, {
    onNone: () => [],
    onSome: (index) => index.items.map((tool) => tool.name),
  });
  return (
    <Select
      value={value ?? ""}
      disabled={disabled || tools.length === 0}
      onValueChange={(next) => onChange(tools.find((tool) => tool === next))}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue
          placeholder={
            Option.isNone(listing)
              ? "Loading tools…"
              : tools.length === 0
                ? "The app has no tools"
                : "Choose a tool"
          }
        />
      </SelectTrigger>
      <SelectContent>
        {tools.map((tool) => (
          <SelectItem key={tool} value={tool} className="font-mono">
            {tool}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
