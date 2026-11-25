// JHPATCH: the organization's risk policy page
import { createFileRoute } from "@tanstack/react-router";
import { RiskPolicyPage, riskPolicyPageReads } from "@executor-js/hosted-web/pages/risk-policy";

/** The organization's risk policy, shared by hosted products. */
export const Route = createFileRoute("/org/$organizationSlug/risk-policy")({
  component: RiskPolicyPage,
  staticData: { organizationReads: riskPolicyPageReads },
});
