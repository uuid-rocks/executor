/** Native schema interop for app libraries written in Effect; ordinary authors use apps. */
export { HttpUrl, JsonObject, type JsonValue, ValidationError } from "./contracts/schema.ts";
export {
  compileJsonSchemaDecoder,
  jsonSchemaDecoder,
  decoderOf,
  wrap,
} from "./implementation/schema.ts";
export type { PromiseMethods } from "./implementation/authoring.ts";
export { ToolAnnotations } from "./contracts/tools.ts";
export { ApprovalDecision, type Approval, type ApprovalContext } from "./contracts/approval.ts";
// JHPATCH: the native form of a tool's risk tier.
export type { Risk } from "./contracts/approval.ts";
export { RiskTier } from "./contracts/protocols/current.ts";
/** Native host dispatch for trusted bundled apps; credentials remain invocation-local. */
export { createAppHandler } from "./implementation/host.ts";
/** Parse a form and build its response parser for a host-owned interaction. */
export { prepareElicitation } from "./implementation/elicitation.ts";
