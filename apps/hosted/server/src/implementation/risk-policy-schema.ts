// JHPATCH: storage for organization risk policies, tool tier overrides and the log's risk columns.
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/**
 * Additive: two new tables and four nullable columns on the tool call log, with no default, so
 * adding them rewrites nothing and the busy table's lock is held only for the catalog change. The
 * running server never reads them; an organization with no policy row uses the defaults. No check
 * on the log's new columns: adding one would scan the table under that lock.
 */
export const migrateToolRisk = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists hosted_risk_policies (
    organization_id text primary key references organization(id) on delete cascade,
    tiers jsonb not null,
    revision text not null default gen_random_uuid()::text,
    updated_at timestamptz not null default now(),
    updated_by text references "user"(id) on delete set null,
    updated_by_name text
  )`;
  // An override goes with its app's access record, which goes with the app and the organization.
  yield* sql`create table if not exists hosted_tool_risk_overrides (
    organization_id text not null,
    app_id text not null,
    tool text not null,
    risk text not null check (risk in ('low', 'medium', 'high', 'critical')),
    set_by text references "user"(id) on delete set null,
    set_by_name text,
    set_at timestamptz not null default now(),
    primary key (organization_id, app_id, tool),
    foreign key (organization_id, app_id) references hosted_app_access(organization_id, id) on delete cascade
  )`;
  yield* sql`create index if not exists hosted_tool_risk_overrides_set_by
    on hosted_tool_risk_overrides (set_by) where set_by is not null`;
  yield* sql`alter table hosted_tool_calls
    add column if not exists risk text,
    add column if not exists risk_action text,
    add column if not exists arguments jsonb,
    add column if not exists arguments_truncated boolean`;
});
