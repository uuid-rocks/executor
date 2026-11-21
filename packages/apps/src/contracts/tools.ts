/** Agent-facing metadata. Apps author queries and mutations. */
import { Schema } from "effect";
// JHPATCH: default risk tiers are derived from a tool's kind and hints.
import type { RiskTier } from "./protocols/current.ts";

/** Advisory tool hints; neither the framework nor these declarations enforce access. */
export const ToolAnnotations = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  readOnlyHint: Schema.optionalKey(Schema.Boolean),
  destructiveHint: Schema.optionalKey(Schema.Boolean),
  idempotentHint: Schema.optionalKey(Schema.Boolean),
  openWorldHint: Schema.optionalKey(Schema.Boolean),
});
export type ToolAnnotations = typeof ToolAnnotations.Type;

// JHPATCH: the tier a tool gets when nothing declares one, shared by builds and hosts.
/**
 * The risk tier of a tool that declares none: a query is `low`, a tool whose hints say it is
 * destructive is `high`, and any other write is `medium`.
 */
export const defaultRiskTier = (
  readOnly: boolean,
  annotations: ToolAnnotations | undefined,
): RiskTier => (readOnly ? "low" : annotations?.destructiveHint === true ? "high" : "medium");

/** Tiers from lowest to highest. */
export const riskTiers = [
  "low",
  "medium",
  "high",
  "critical",
] as const satisfies readonly RiskTier[];

/** The higher of two tiers. */
export const higherRisk = (a: RiskTier, b: RiskTier): RiskTier =>
  riskTiers.indexOf(a) >= riskTiers.indexOf(b) ? a : b;
