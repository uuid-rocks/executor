// JHPATCH: the tool call log keeps a call's arguments when the risk policy says so, secrets removed.
/**
 * A call's arguments as the tool call log keeps them: values under keys that name secrets, and
 * strings that look like credentials, replaced; long strings cut; deep values and a large whole
 * reduced. The log is read by administrators and the caller, not by whoever the arguments were
 * meant for, so a secret a caller passed must not land there. Matching is by shape, so it errs
 * toward redacting text that only looks like a secret.
 */
import type { Schema } from "effect";

const redacted = "[redacted]";
const cut = "[truncated]";

const secretKey =
  /pass(word|wd)?|secret|token|api[-_]?key|auth(orization)?|cookie|session|credential|private[-_]?key|signature/iu;
const secretValues = [
  /\b(?:sk_live|sk_test|rk_live|rk_test)_[0-9A-Za-z]{8,}/u,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[0-9A-Za-z]{20,}/u,
  /\bgithub_pat_[0-9A-Za-z_]{20,}/u,
  /\bxox[abprs]-[0-9A-Za-z-]{8,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\beyJ[0-9A-Za-z_-]+\.[0-9A-Za-z_-]+\.[0-9A-Za-z_-]+/u,
  /\bBearer\s+\S+/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
];

/** Deeper values become `[truncated]`. */
const maxDepth = 8;
/** The most bytes the kept value may take as JSON. */
const maxBytes = 16 * 1024;
/**
 * Ever tighter limits, tried in order until the value fits `maxBytes`: the longest string kept and
 * the most items of an array or entries of an object.
 */
const limits = [
  { text: 2048, items: Number.POSITIVE_INFINITY },
  { text: 256, items: 100 },
  { text: 64, items: 20 },
] as const;

interface Reduced {
  truncated: boolean;
}

const reduce = (
  value: unknown,
  depth: number,
  limit: (typeof limits)[number],
  state: Reduced,
): Schema.Json => {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    if (secretValues.some((pattern) => pattern.test(value))) return redacted;
    if (value.length <= limit.text) return value;
    state.truncated = true;
    return value.slice(0, limit.text);
  }
  if (typeof value !== "object") return null;
  if (depth >= maxDepth) {
    state.truncated = true;
    return cut;
  }
  if (Array.isArray(value)) {
    if (value.length > limit.items) state.truncated = true;
    return value.slice(0, limit.items).map((item) => reduce(item, depth + 1, limit, state));
  }
  const entries = Object.entries(value);
  if (entries.length > limit.items) state.truncated = true;
  return Object.fromEntries(
    entries
      .slice(0, limit.items)
      .map(([key, item]) => [
        key,
        secretKey.test(key) ? redacted : reduce(item, depth + 1, limit, state),
      ]),
  );
};

const encoder = new TextEncoder();

/**
 * The arguments to keep, and whether any part was cut. A value that does not fit even at the
 * tightest limits is kept as null, truncated.
 */
export const scrubArguments = (
  input: unknown,
): { readonly value: Schema.Json; readonly truncated: boolean } => {
  for (const limit of limits) {
    const state: Reduced = { truncated: false };
    const value = reduce(input ?? null, 0, limit, state);
    if (encoder.encode(JSON.stringify(value)).length <= maxBytes)
      return { value, truncated: state.truncated };
  }
  return { value: null, truncated: true };
};
