---
"@executor-js/hosted-cloud": patch
---

Cloud can deploy against an existing Postgres database. Set `CLOUD_DATABASE_URL`
and the deploy migrates that database and uses it instead of creating a PlanetScale
database. Set `CLOUD_DATABASE_HYPERDRIVE=true` to connect to it through Hyperdrive.
