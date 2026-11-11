---
"@executor-js/hosted-cloud": patch
---

Cloud can deploy against an existing Postgres database. Set `CLOUD_DATABASE_URL`
and the deploy uses that database through Hyperdrive instead of creating a
PlanetScale database. `CLOUD_DATABASE_MIGRATION_URL` optionally runs migrations
as a different user.
