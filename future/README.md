# Not shipped

`synology_system.ts` implements a second model type — the appliance's advertised
API catalogue plus normalised identity, uptime and thermal state.

It is not in `manifest.yaml` and does not load, because it calls
`SYNO.Core.System`, which requires a DSM **administrator** account. The
published extension is built around a non-admin account, so this type has never
made a successful API call against a real appliance.

Shipping a model type that has never run would undercut the one that has. It
stays here until it can be verified against an admin-scoped account on hardware,
at which point it needs adding back to `manifest.yaml` and covering with tests.

The code is complete and type-checks; only the verification is missing.
