---
"@executor-js/hosted-cloud": patch
---

Cloud can deploy against an existing Postgres database. Set `CLOUD_DATABASE_URL`
and the deploy migrates that database and uses it through Hyperdrive instead of
creating a PlanetScale database.
