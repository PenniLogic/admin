# Admin client-state quality gate

This bounded adoption references the source-of-state-list Definition of Done in
[PenniLogic/docs#1](https://github.com/PenniLogic/docs/issues/1), not a new product ticket.
The contract is sections 12 and 13 of the
[accepted taxonomy](https://github.com/PenniLogic/docs/blob/a700e639585c61a4610e7b99dbd02b2dab28bdcc/product/client-state-taxonomy.md#12-future-client-gate-adoption).

## Native execution and boundary

`npm test` discovers `tests/unit/client-state-taxonomy.test.ts` in the existing Vitest unit
project. It reads the checked-in production registry and evidence and runs the assertions;
this is not an unused workflow or an optional network check. For the focused tests:

```text
npm test -- tests\unit\client-state-taxonomy.test.ts --coverage.enabled=false
```

The focused command disables the existing full-scaffold coverage thresholds, which cannot
be met by a single test file. The normal `npm test` retains every existing threshold and
scaffold check. The new tooling is exercised by the unit suite; like the other tooling
entry points, it is not added to the existing threshold scope.

Nothing imports this gate into the application. It adds no dependency, runtime state,
administrative feature, permission, API binding, recovery control or auth provider.
The scaffold denial is not registered as a product `permission_denied` surface: its fixed
response intentionally has no recovery action. Its default deny, import boundary, bundle
and customer-artifact constraints remain in force.

## Immutable offline source

`quality/client-state-taxonomy/client-state-taxonomy.json` and its `.schema.json` are
unchanged bytes from `PenniLogic/docs` commit
`a700e639585c61a4610e7b99dbd02b2dab28bdcc`, tree
`3879d3893a3f289bd6b0d4474f09dbebf1fef195`, taxonomy `1.1.0`, schema version `1`.
`source.json` records the full source paths, commit, tree, byte lengths, SHA-256 values
and Git blob hashes. `tools/client-state-gate/taxonomy.ts` independently pins those facts
and checks both hashes of each consumed artifact before projecting the client fields.
The document's hash records provenance; its prose is not vendored or revalidated here.

The eight IDs, scopes, canonical copy, copy variants, cause classes, recovery IDs and labels,
placeholders and their sources, forbidden terms, and declared guarantees come from DATA.
The surface-registration field names and required fields come from SCHEMA. This is a
consumer, not a duplicate of the Docs validator. CI never fetches, executes or vendors a
provider script. Missing files, changed bytes, stale versions, malformed JSON, duplicate
JSON keys, unknown fields and duplicate registrations or identifiers are errors.

The existing customer-artifact tripwire exempts only the exact pinned schema path's literal
`$schema` documentation URI after an independent SHA-256 check against the accepted source.
It does not skip the file, broaden the host allowlist, alter fixture allowances or exempt its
other contents. Negative controls keep that hostname forbidden in other files, reject changed
schema bytes and reject added runtime/network hosts. Cookie and secret scans still inspect the
original schema bytes; runtime source and its scans are unchanged.

To upgrade, follow the source's section 13: obtain the accepted version first, verify its
commit/tree/blobs, then update the unchanged artifacts, source manifest, code pin and independent
tripwire hash in a reviewed change.
There is no floating `main`, automatic update or runtime fetch.

## Registry and evidence contract

`registry.json` has exactly `gate_schema_version` (`1`), `client` (`admin`),
`taxonomy_version` (`1.1.0`), `coverage_status`, `client_states`, and `surfaces`.
`client_states` is the client's explicit enumeration. `taxonomy_first` checks its actual
subset relationship to DATA; duplicates and unknown IDs fail. Every applicable registration
ID must also be in that enumeration. Inventory completeness requires the future surface
owner's review; this gate does not discover unregistered runtime features.

Each surface follows SCHEMA's `definitions.surface_registration`: `surface_id`, `client`,
`applicable_states`, `item`, `attempt`, and only the published optional fields.
Registered capabilities bind the `{capability}` placeholder. Registered copy fields bind
their matching placeholders. Optional freshness windows must be positive safe integers.
`coverage_status` is `registered` for nonempty registrations, otherwise `not_exercised`.

`evidence.json` has exactly `gate_schema_version`, `client`, `taxonomy_version`,
`evidence_kind`, and `observations`. Each observation has:

| Field | Meaning |
| --- | --- |
| `surface_id`, `client`, `taxonomy_version`, `state`, `scope` | The registered surface, exact client/version, applicable DATA ID and permitted scope |
| `copy` | Exactly the actually observed `headline` and `body`, not expected strings substituted by a test adapter |
| `recovery_actions` | All observed state recovery controls, each with `id` and `label`; exactly one is permitted |
| `placeholders` | Exactly the used IDs, each with `source` and `value`; sources must match DATA, and registration-sourced values must match the registration |
| `data_display` | Observed DATA display mode; must match the state |
| `connectivity` | `online`, `offline` or `unknown`; `offline` requires the platform observation, never an inference from a failed request |
| `offline_marker` | Empty unless `stale` is offline, when it is exactly DATA's offline headline, not a second state/action |
| `guarantees` | Exactly the state's DATA guarantee keys and values, collected by the adapter's assertions |
| Optional `cause` or `variant` | A published cause binding or a non-cause copy variant; never both |

`permission_denied` retains separate `device`, `plan`, `sharing` and `role` bindings.
Cause-specific copy and labels cannot be substituted for each other. Default, role, plan
and sharing copy accept no placeholders or hidden-resource hints. Device copy accepts
only its published, source-bound placeholders. The validation variant of `error` is
action-scoped and retains the registered submit label. Quota copy keeps its published
positive availability wording and only the service-sourced limit/reset placeholders.
No gate diagnostic echoes submitted copy, placeholder values, hidden identifiers or data.

`client_state_coverage` checks every registration/applicable-state pair for an observation,
then checks exact permitted copy, placeholders, one published action, scopes, causes,
display modes and declared guarantees. A planted omission fails. Duplicate observations,
unregistered surfaces and inapplicable states also fail. An offline region with data is
observed as `stale` with its offline marker; a no-data `offline` observation cannot claim
`shown_marked`. This gate does not invent concrete API refusals or sharing leases.

## What this does not prove

The production registry and observations start empty with explicit `not_exercised` status.
That result is **no product coverage**, not PASS. The gate rejects nonempty evidence for an
empty registry and rejects `not_exercised` evidence for registered surfaces.

The native tests construct named `synthetic_` fixture surfaces, never copy the provider's
illustrative registration into production. `synthetic` evidence returns `synthetic_only`.
It cannot be submitted as `rendered_observation` under a synthetic or example surface ID.
`rendered_observation` returns only `observations_checked`, not product acceptance:
origin, real DOM/control enumeration, service/platform facts and guarantees must be supplied
by an independently reviewed adapter. A caller's declaration cannot establish those facts.

These tests prove the assertion machinery, including wrong copy, unknown IDs, planted
omissions, duplicate actions, denial privacy and stale/offline distinctions. They do not
prove any admin surface, accessibility, physical-device behavior, plural grammar, complete
semantic privacy of arbitrary placeholder prose, recovery behavior, stale marker association,
focus, performance, observability, localization or API implementation. Those remain with
the appropriate product tickets, adapters and independent QA/specialist review.
The copy-bearing `loading` observation is after the published slow threshold; pre-threshold
skeleton and timing acceptance also remain unexercised.

Rollout adds an offline native test gate only; nothing is deployed. Rollback is a reviewed
revert of this adoption, leaving the deny-only scaffold unchanged.
