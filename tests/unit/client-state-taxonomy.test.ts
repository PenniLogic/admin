import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkClientStateGate,
  clientStateCoverage,
  readNativeClientStateGate,
  taxonomyFirst,
} from "@/tools/client-state-gate/assertions";
import { parseJson } from "@/tools/client-state-gate/input";
import {
  QUALITY_DIRECTORY,
  readPinnedTaxonomy,
  SOURCE_PIN,
  verifyPinnedTaxonomy,
} from "@/tools/client-state-gate/taxonomy";
import type { StateDefinition } from "@/tools/client-state-gate/taxonomy";

const taxonomy = readPinnedTaxonomy();
const pinnedFiles = {
  data: readFileSync(new URL("client-state-taxonomy.json", QUALITY_DIRECTORY)),
  schema: readFileSync(new URL("client-state-taxonomy.schema.json", QUALITY_DIRECTORY)),
  source: readFileSync(new URL("source.json", QUALITY_DIRECTORY), "utf8"),
};
const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true });
  temporaryDirectories.clear();
});

function definition(id: string): StateDefinition {
  const result = taxonomy.states.get(id);
  if (result === undefined) throw new Error("Synthetic fixture needs a published state");
  return result;
}

function registration(states: string[]) {
  return {
    surface_id: "synthetic_native_gate",
    client: "admin",
    applicable_states: states,
    item: "test items",
    attempt: "load test items",
    primary_action: "Add an item",
    what_appears_here: "Items created in this fixture appear here.",
    still_available: "Saved items and manual tools",
    submit_label: "Save",
    capabilities: ["Optional summaries"],
    freshness_window_seconds: 60,
  };
}

const SYNTHETIC_VALUES: Readonly<Record<string, string>> = {
  item: "test items",
  attempt: "load test items",
  primary_action: "Add an item",
  what_appears_here: "Items created in this fixture appear here.",
  still_available: "Saved items and manual tools",
  submit_label: "Save",
  capability: "Optional summaries",
  permission: "camera access",
  last_updated: "moments ago",
  limit: "5 checks",
  resets_at: "tomorrow",
  field_guidance: "Enter a title.",
};

interface SyntheticObservation {
  surface_id: string;
  client: string;
  taxonomy_version: string;
  state: string;
  scope: string;
  copy: { headline: string; body: string };
  recovery_actions: { id: string; label: string }[];
  placeholders: Record<string, { source: string; value: string }>;
  data_display: string;
  connectivity: string;
  offline_marker: string;
  guarantees: Record<string, boolean>;
  cause?: string;
  variant?: string;
}

function syntheticObservation(id: string, options: { cause?: string; variant?: string } = {}): SyntheticObservation {
  const state = definition(id);
  const selection = options.cause ?? options.variant;
  const copy = selection === undefined ? state.copy : state.variants.get(selection);
  if (copy === undefined) throw new Error("Synthetic fixture needs a published copy variant");
  const label = options.cause === undefined
    ? (options.variant === undefined ? state.recoveryLabel : state.labelsByVariant.get(options.variant) ?? state.recoveryLabel)
    : state.labelsByCause.get(options.cause);
  if (label === undefined) throw new Error("Synthetic fixture needs a published recovery label");
  const placeholders: SyntheticObservation["placeholders"] = {};
  for (const template of [copy.headline, copy.body, label]) {
    for (const match of template.matchAll(/\{([a-z][a-z0-9_]*)\}/g)) {
      const name = match[1];
      if (name === undefined) throw new Error("Synthetic fixture placeholder is absent");
      const source = taxonomy.placeholders.get(name);
      const value = SYNTHETIC_VALUES[name];
      if (source === undefined || value === undefined) throw new Error("Synthetic fixture placeholder is unpublished");
      placeholders[name] = { source, value };
    }
  }
  const fill = (template: string): string => template.replace(/\{([a-z][a-z0-9_]*)\}/g, (_match: string, name: string) => {
    const value = SYNTHETIC_VALUES[name];
    if (value === undefined) throw new Error("Synthetic fixture placeholder is absent");
    return value;
  });
  return {
    surface_id: "synthetic_native_gate",
    client: "admin",
    taxonomy_version: taxonomy.version,
    state: id,
    scope: options.variant === "validation" ? "action" : (state.scopes.includes("region") ? "region" : "surface"),
    copy: { headline: fill(copy.headline), body: fill(copy.body) },
    recovery_actions: [{ id: state.recoveryId, label: fill(label) }],
    placeholders,
    data_display: state.dataDisplay,
    connectivity: ["offline", "stale"].includes(id) ? "offline" : "online",
    offline_marker: id === "stale" ? definition("offline").copy.headline : "",
    guarantees: Object.fromEntries<boolean>(state.guarantees),
    ...options,
  };
}

function fixture(states = [...taxonomy.states.keys()]) {
  return {
    registry: {
      gate_schema_version: 1,
      client: "admin",
      taxonomy_version: taxonomy.version,
      coverage_status: "registered",
      client_states: states,
      surfaces: [registration(states)],
    },
    evidence: {
      gate_schema_version: 1,
      client: "admin",
      taxonomy_version: taxonomy.version,
      evidence_kind: "synthetic",
      observations: states.map((id) => syntheticObservation(id)),
    },
  };
}

function check(value: ReturnType<typeof fixture>) {
  return checkClientStateGate(taxonomy, value.registry, value.evidence);
}

describe("immutable shared taxonomy source", () => {
  it("pins the accepted commit, tree, version and the actual eight DATA identifiers", () => {
    expect(SOURCE_PIN.commit).toBe("a700e639585c61a4610e7b99dbd02b2dab28bdcc");
    expect(SOURCE_PIN.tree).toBe("3879d3893a3f289bd6b0d4474f09dbebf1fef195");
    expect(taxonomy.version).toBe("1.1.0");
    expect([...taxonomy.states.keys()]).toEqual([
      "empty", "loading", "error", "offline", "stale", "permission_denied", "quota_exceeded", "degraded",
    ]);
    expect(taxonomy.assertionIds).toEqual(["client_state_coverage", "taxonomy_first"]);
    expect(parseJson(pinnedFiles.source)).toEqual(SOURCE_PIN);
  });

  it.each(["data", "schema"])("rejects changed %s bytes before consumption", (file) => {
    const changed = { ...pinnedFiles };
    if (file === "data") changed.data = Buffer.concat([pinnedFiles.data, Buffer.from("\n")]);
    else changed.schema = Buffer.concat([pinnedFiles.schema, Buffer.from("\n")]);
    expect(() => verifyPinnedTaxonomy(changed)).toThrow("client-state-gate:pinned_bytes");
  });

  it("rejects stale DATA even if it is valid JSON", () => {
    const data = Buffer.from(pinnedFiles.data.toString("utf8").replace('"taxonomy_version": "1.1.0"', '"taxonomy_version": "1.0.0"'));
    expect(() => verifyPinnedTaxonomy({ ...pinnedFiles, data })).toThrow("client-state-gate:pinned_bytes");
  });

  it.each([
    { commit: "0000000000000000000000000000000000000000" },
    { tree: "0000000000000000000000000000000000000000" },
    { taxonomy_version: "1.0.0" },
    { repository: "PenniLogic/admin" },
    { extra: "unpublished" },
    { data: { ...SOURCE_PIN.data, git_blob: "0000000000000000000000000000000000000000" } },
    { schema: { ...SOURCE_PIN.schema, sha256: "0".repeat(64) } },
  ])("rejects an altered source matrix: %j", (change) => {
    expect(() => verifyPinnedTaxonomy({ ...pinnedFiles, source: JSON.stringify({ ...SOURCE_PIN, ...change }) }))
      .toThrow("client-state-gate:source_pin");
  });

  it("rejects missing source metadata instead of using a default", () => {
    expect(() => verifyPinnedTaxonomy({ ...pinnedFiles, source: "{}" })).toThrow("client-state-gate:source_pin");
  });

  it("fails when a pinned artifact is absent", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "admin-client-state-gate-"));
    temporaryDirectories.add(directory);
    expect(() => readPinnedTaxonomy(pathToFileURL(directory + path.sep))).toThrow(/ENOENT/);
  });

  it.each(['{"unfinished":', "\uFEFF{}", '{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"outer":{"key":1,"key":2}}'])(
    "rejects malformed JSON or duplicate keys: %j",
    (source) => {
      expect(() => parseJson(source)).toThrow(/client-state-gate:(malformed_json|duplicate_json_key)/);
    },
  );

  it("accepts the same key in separate JSON objects, not a false duplicate", () => {
    expect(parseJson('{"one":{"key":1},"two":{"key":2}}')).toEqual({ one: { key: 1 }, two: { key: 2 } });
  });
});

describe("native admin taxonomy_first", () => {
  it("checks a genuine subset, not equality to all published IDs", () => {
    expect(taxonomyFirst(taxonomy, ["error", "stale"])).toEqual({
      assertion: "taxonomy_first", status: "subset_checked", checked_identifiers: 2,
    });
  });

  it("reports an empty enumeration as not exercised", () => {
    expect(taxonomyFirst(taxonomy, [])).toEqual({
      assertion: "taxonomy_first", status: "not_exercised", checked_identifiers: 0,
    });
  });

  it.each([
    { input: ["unpublished_state"], rule: "taxonomy_first" },
    { input: ["error", "error"], rule: "duplicate_identifier" },
    { input: ["Error"], rule: "taxonomy_first" },
    { input: ["permission-denied"], rule: "taxonomy_first" },
    { input: [1], rule: "text_required" },
    { input: undefined, rule: "array_required" },
  ])("rejects unknown, duplicate or malformed enumeration: %j", ({ input, rule }) => {
    expect(() => taxonomyFirst(taxonomy, input)).toThrow(`client-state-gate:${rule}`);
  });

  it("does not claim product coverage for the production registry or provider illustration", () => {
    const result = readNativeClientStateGate();
    expect(result.taxonomy_first.status).toBe("not_exercised");
    expect(result.client_state_coverage).toEqual({
      assertion: "client_state_coverage", status: "not_exercised", evidence_kind: "not_exercised",
      registered_surfaces: 0, observed_states: 0,
    });
  });
});

describe("native synthetic client_state_coverage", () => {
  it("checks all eight synthetic states without treating them as product evidence", () => {
    expect(check(fixture()).client_state_coverage).toEqual({
      assertion: "client_state_coverage", status: "synthetic_only", evidence_kind: "synthetic",
      registered_surfaces: 1, observed_states: 8,
    });
  });

  it.each([...taxonomy.states.keys()])("a planted omission of %s fails coverage", (state) => {
    const value = fixture();
    value.evidence.observations = value.evidence.observations.filter((entry) => entry.state !== state);
    expect(() => check(value)).toThrow("client-state-gate:missing_state");
  });

  it.each(["headline", "body"])("rejects paraphrased %s", (field) => {
    const value = fixture(["offline"]);
    const entry = syntheticObservation("offline");
    if (field === "headline") entry.copy.headline = "No connection at the moment";
    else entry.copy.body = "Please reconnect and retry.";
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:canonical_copy");
  });

  it("rejects duplicate recovery controls", () => {
    const value = fixture(["offline"]);
    const entry = syntheticObservation("offline");
    entry.recovery_actions.push({ ...entry.recovery_actions[0], id: "retry", label: "Try again" });
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:one_recovery_action");
  });

  it("rejects a missing recovery control", () => {
    const value = fixture(["offline"]);
    const entry = syntheticObservation("offline");
    entry.recovery_actions = [];
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:one_recovery_action");
  });

  it.each([{ id: "invented_action", label: "Try again" }, { id: "retry", label: "Retry" }])(
    "rejects an unpublished action or label: %j",
    (action) => {
      const value = fixture(["offline"]);
      const entry = syntheticObservation("offline");
      entry.recovery_actions = [action];
      value.evidence.observations = [entry];
      expect(() => check(value)).toThrow("client-state-gate:canonical_recovery");
    },
  );

  it("rejects duplicate observations", () => {
    const value = fixture(["offline"]);
    value.evidence.observations.push(syntheticObservation("offline"));
    expect(() => check(value)).toThrow("client-state-gate:duplicate_observation");
  });

  it("rejects duplicate surfaces", () => {
    const value = fixture(["offline"]);
    value.registry.surfaces.push(registration(["offline"]));
    expect(() => check(value)).toThrow("client-state-gate:duplicate_surface");
  });

  it("rejects unknown registration fields rather than ignoring them", () => {
    const value = fixture(["offline"]);
    const registry = { ...value.registry, surfaces: [{ ...registration(["offline"]), hidden_hint: "unpublished" }] };
    expect(() => clientStateCoverage(taxonomy, registry, value.evidence)).toThrow("client-state-gate:unknown_field");
  });

  it("rejects a state declared applicable but absent from the client enumeration", () => {
    const value = fixture(["offline"]);
    value.registry.surfaces = [registration(["offline", "stale"])];
    expect(() => check(value)).toThrow("client-state-gate:unlisted_client_state");
  });

  it("rejects an observation of an unregistered surface", () => {
    const value = fixture(["offline"]);
    const entry = syntheticObservation("offline");
    entry.surface_id = "synthetic_unregistered";
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:unregistered_surface");
  });

  it("rejects an inapplicable observed state", () => {
    const value = fixture(["offline"]);
    value.evidence.observations = [syntheticObservation("stale")];
    expect(() => check(value)).toThrow("client-state-gate:inapplicable_state");
  });

  it("rejects an unpublished observed state", () => {
    const value = fixture(["offline"]);
    const entry = syntheticObservation("offline");
    entry.state = "unpublished_state";
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:taxonomy_first");
  });

  it.each(["web", "android", "unpublished"])("rejects a non-admin evidence client: %s", (client) => {
    const value = fixture(["offline"]);
    value.evidence.client = client;
    expect(() => check(value)).toThrow("client-state-gate:client");
  });

  it("rejects stale observation and registry versions", () => {
    const value = fixture(["offline"]);
    value.registry.taxonomy_version = "1.0.0";
    expect(() => check(value)).toThrow("client-state-gate:taxonomy_version");
    value.registry.taxonomy_version = taxonomy.version;
    value.evidence.taxonomy_version = "1.0.0";
    expect(() => check(value)).toThrow("client-state-gate:taxonomy_version");
    value.evidence.taxonomy_version = taxonomy.version;
    const entry = syntheticObservation("offline");
    entry.taxonomy_version = "1.0.0";
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:taxonomy_version");
  });

  it.each(["unpublished", "action"])("rejects a stale observation at an invalid scope: %s", (scope) => {
    const value = fixture(["stale"]);
    const entry = syntheticObservation("stale");
    entry.scope = scope;
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:state_scope");
  });

  it("rejects unexercised evidence with registered surfaces", () => {
    const value = fixture(["offline"]);
    value.evidence.evidence_kind = "not_exercised";
    expect(() => check(value)).toThrow("client-state-gate:evidence_kind");
  });

  it("rejects observations attached to an empty production registry", () => {
    const value = fixture(["offline"]);
    value.registry.surfaces = [];
    value.registry.coverage_status = "not_exercised";
    value.evidence.evidence_kind = "not_exercised";
    expect(() => check(value)).toThrow("client-state-gate:unexercised_evidence");
  });

  it("rejects relabelling synthetic observations as real rendered evidence", () => {
    const value = fixture(["offline"]);
    value.evidence.evidence_kind = "rendered_observation";
    expect(() => check(value)).toThrow("client-state-gate:evidence_boundary");
  });

  it("does not promote a caller's purported adapter observation to product acceptance", () => {
    const value = fixture(["offline"]);
    value.registry.surfaces = [{ ...registration(["offline"]), surface_id: "adapter_contract_probe" }];
    const entry = syntheticObservation("offline");
    entry.surface_id = "adapter_contract_probe";
    value.evidence.observations = [entry];
    value.evidence.evidence_kind = "rendered_observation";
    expect(check(value).client_state_coverage.status).toBe("observations_checked");
  });
});

describe("strict registration and evidence inputs", () => {
  it.each([{ registry: undefined }, { registry: null }, { registry: [] }, { registry: "" }])(
    "rejects missing or malformed registry input: %j",
    ({ registry }) => {
      expect(() => clientStateCoverage(taxonomy, registry, fixture(["offline"]).evidence))
        .toThrow("client-state-gate:object_required");
    },
  );

  it("rejects unknown fields in registry, evidence and individual observations", () => {
    const value = fixture(["offline"]);
    expect(() => clientStateCoverage(taxonomy, { ...value.registry, unexpected: true }, value.evidence))
      .toThrow("client-state-gate:unknown_field");
    expect(() => clientStateCoverage(taxonomy, value.registry, { ...value.evidence, unexpected: true }))
      .toThrow("client-state-gate:unknown_field");
    const evidence = { ...value.evidence, observations: [{ ...syntheticObservation("offline"), unexpected: true }] };
    expect(() => clientStateCoverage(taxonomy, value.registry, evidence)).toThrow("client-state-gate:unknown_field");
  });

  it("rejects missing required registration fields", () => {
    const value = fixture(["offline"]);
    const { item: omitted, ...incomplete } = registration(["offline"]);
    expect(omitted).toBe("test items");
    expect(() => clientStateCoverage(taxonomy, { ...value.registry, surfaces: [incomplete] }, value.evidence))
      .toThrow("client-state-gate:missing_field");
  });

  it.each([{ states: [] }, { states: ["offline", "offline"] }, { states: ["unpublished_state"] }])(
    "rejects invalid applicable IDs: %j",
    ({ states }) => {
      const value = fixture(["offline"]);
      value.registry.surfaces = [registration(states)];
      expect(() => check(value)).toThrow(/client-state-gate:(empty_list|duplicate_identifier|taxonomy_first)/);
    },
  );

  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects an invalid freshness window: %s", (seconds) => {
    const value = fixture(["stale"]);
    value.registry.surfaces = [{ ...registration(["stale"]), freshness_window_seconds: seconds }];
    expect(() => check(value)).toThrow("client-state-gate:freshness_window");
  });

  it("rejects a wrong registry, registration or observation client", () => {
    const value = fixture(["offline"]);
    value.registry.client = "web";
    expect(() => check(value)).toThrow("client-state-gate:client");
    value.registry.client = "admin";
    value.registry.surfaces = [{ ...registration(["offline"]), client: "web" }];
    expect(() => check(value)).toThrow("client-state-gate:client");
    value.registry.surfaces = [registration(["offline"])];
    const entry = syntheticObservation("offline");
    entry.client = "web";
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:client");
  });

  it("rejects unknown local gate schema versions", () => {
    const value = fixture(["offline"]);
    value.registry.gate_schema_version = 2;
    expect(() => check(value)).toThrow("client-state-gate:gate_schema_version");
    value.registry.gate_schema_version = 1;
    value.evidence.gate_schema_version = 2;
    expect(() => check(value)).toThrow("client-state-gate:gate_schema_version");
  });

  it("rejects malformed observations rather than inventing an empty list", () => {
    const value = fixture(["offline"]);
    expect(() => clientStateCoverage(taxonomy, value.registry, { ...value.evidence, observations: null }))
      .toThrow("client-state-gate:array_required");
  });

  it("rejects unknown display modes, connectivity and added guarantees", () => {
    const value = fixture(["offline"]);
    const entry = syntheticObservation("offline");
    entry.data_display = "unpublished";
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:data_display");
    entry.data_display = definition("offline").dataDisplay;
    entry.connectivity = "inferred";
    expect(() => check(value)).toThrow("client-state-gate:connectivity");
    entry.connectivity = "offline";
    entry.guarantees["hidden_item_count"] = true;
    expect(() => check(value)).toThrow("client-state-gate:unknown_field");
  });
});

describe("synthetic denial privacy and cause bindings", () => {
  it.each(["device", "plan", "sharing", "role"])("checks the DATA copy and action for cause %s", (cause) => {
    const value = fixture(["permission_denied"]);
    value.evidence.observations = [syntheticObservation("permission_denied", { cause })];
    expect(check(value).client_state_coverage.status).toBe("synthetic_only");
  });

  it("keeps the administrative role copy and recovery separate from plan and sharing", () => {
    const entry = syntheticObservation("permission_denied", { cause: "role" });
    expect(entry.copy).toEqual({
      headline: "Not part of your current access", body: "Everything else keeps working.",
    });
    expect(entry.recovery_actions).toEqual([{ id: "review_access", label: "Request access" }]);
    const value = fixture(["permission_denied"]);
    entry.copy = syntheticObservation("permission_denied", { cause: "plan" }).copy;
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:canonical_copy");
  });

  it("does not allow a device recovery label for an administrative role denial", () => {
    const value = fixture(["permission_denied"]);
    const entry = syntheticObservation("permission_denied", { cause: "role" });
    entry.recovery_actions = [{ id: "review_access", label: "Allow camera access" }];
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:canonical_recovery");
  });

  it("rejects an unpublished cause or cause selected as a free copy variant", () => {
    const value = fixture(["permission_denied"]);
    const entry = syntheticObservation("permission_denied");
    entry.cause = "invented_cause";
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:cause");
    delete entry.cause;
    entry.variant = "role";
    expect(() => check(value)).toThrow("client-state-gate:cause_required");
  });

  it("rejects ambiguous cause and variant selection", () => {
    const value = fixture(["permission_denied"]);
    const entry = syntheticObservation("permission_denied", { cause: "role" });
    entry.variant = "plan";
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:cause");
  });

  it("rejects hidden-resource existence copy without echoing it in the diagnostic", () => {
    const value = fixture(["permission_denied"]);
    const entry = syntheticObservation("permission_denied", { cause: "sharing" });
    const plantedHint = "There are 3 hidden records for Synthetic Person";
    entry.copy.body = plantedHint;
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:canonical_copy");
    expect(() => check(value)).not.toThrow(plantedHint);
  });

  it("rejects inserting a hidden identifier placeholder into sharing denial", () => {
    const value = fixture(["permission_denied"]);
    const entry = syntheticObservation("permission_denied", { cause: "sharing" });
    entry.placeholders["hidden_resource"] = { source: "service_response", value: "synthetic_hidden_id" };
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:unknown_field");
  });

  it.each([
    { rest_of_surface_usable: false, discloses_hidden_data: false },
    { rest_of_surface_usable: true, discloses_hidden_data: true },
  ])("rejects denial guarantees contrary to DATA: %j", (guarantees) => {
    const value = fixture(["permission_denied"]);
    const entry = syntheticObservation("permission_denied", { cause: "role" });
    entry.guarantees = guarantees;
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:state_guarantees");
  });

  it("rejects displaying data behind a denial", () => {
    const value = fixture(["permission_denied"]);
    const entry = syntheticObservation("permission_denied", { cause: "role" });
    entry.data_display = "shown";
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:data_display");
  });
});

describe("synthetic canonical placeholders and published variants", () => {
  it.each(["with_reset", "rate_limited"])("checks the quota variant %s with service-sourced values", (variant) => {
    const value = fixture(["quota_exceeded"]);
    value.evidence.observations = [syntheticObservation("quota_exceeded", { variant })];
    expect(check(value).client_state_coverage.status).toBe("synthetic_only");
  });

  it("keeps a quota with no reset on the default copy, without inventing a reset", () => {
    const value = fixture(["quota_exceeded"]);
    const entry = syntheticObservation("quota_exceeded");
    expect(entry.copy.body).toBe("Saved items and manual tools still work.");
    expect(entry.placeholders["resets_at"]).toBeUndefined();
    entry.placeholders["resets_at"] = { source: "service_response", value: "tomorrow" };
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:unknown_field");
  });

  it("rejects an invented client-side quota limit source", () => {
    const value = fixture(["quota_exceeded"]);
    const entry = syntheticObservation("quota_exceeded");
    entry.placeholders["limit"] = { source: "client_cache", value: "5 checks" };
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:placeholder_source");
  });

  it("rejects a missing required placeholder", () => {
    const value = fixture(["stale"]);
    const entry = syntheticObservation("stale");
    delete entry.placeholders["last_updated"];
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:missing_field");
  });

  it("rejects substituting an unregistered product capability", () => {
    const value = fixture(["degraded"]);
    const entry = syntheticObservation("degraded");
    entry.placeholders["capability"] = { source: "surface_registration", value: "Invented summaries" };
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:registered_placeholder");
  });

  it("rejects changing a registered creating-action label", () => {
    const value = fixture(["empty"]);
    const entry = syntheticObservation("empty");
    entry.placeholders["primary_action"] = { source: "surface_registration", value: "Create a new item" };
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:registered_placeholder");
  });

  it.each(["you failed", "because", "error code"])("rejects forbidden copy injected into a placeholder: %s", (value) => {
    const stateFixture = fixture(["error"]);
    const entry = syntheticObservation("error");
    entry.placeholders["attempt"] = { source: "surface_registration", value };
    stateFixture.evidence.observations = [entry];
    expect(() => check(stateFixture)).toThrow("client-state-gate:forbidden_copy");
  });

  it.each(["$5", "<script>", "hello\nworld", "{unknown}"])("rejects unsafe placeholder prose: %j", (value) => {
    const stateFixture = fixture(["stale"]);
    const entry = syntheticObservation("stale");
    entry.placeholders["last_updated"] = { source: "client_cache", value };
    stateFixture.evidence.observations = [entry];
    expect(() => check(stateFixture)).toThrow("client-state-gate:unsafe_copy");
  });

  it("keeps the error validation variant on the form's registered submit label", () => {
    const value = fixture(["error"]);
    const entry = syntheticObservation("error", { variant: "validation" });
    expect(entry.recovery_actions).toEqual([{ id: "retry", label: "Save" }]);
    value.evidence.observations = [entry];
    expect(check(value).client_state_coverage.status).toBe("synthetic_only");
    entry.recovery_actions = [{ id: "retry", label: "Try again" }];
    expect(() => check(value)).toThrow("client-state-gate:canonical_recovery");
  });

  it("rejects the validation variant outside action scope", () => {
    const value = fixture(["error"]);
    const entry = syntheticObservation("error", { variant: "validation" });
    entry.scope = "region";
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:validation_scope");
  });

  it("rejects unknown variants instead of falling back to default copy", () => {
    const value = fixture(["error"]);
    const entry = syntheticObservation("error");
    entry.variant = "invented_variant";
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:copy_variant");
  });
});

describe("synthetic stale versus offline", () => {
  it("keeps held data stale with one offline marker and the refresh action", () => {
    const value = fixture(["stale"]);
    const entry = syntheticObservation("stale");
    expect(entry.copy.headline).toBe("Last updated moments ago");
    expect(entry.data_display).toBe("shown_marked");
    expect(entry.offline_marker).toBe("You're offline");
    expect(entry.recovery_actions).toEqual([{ id: "refresh", label: "Refresh" }]);
    expect(check(value).client_state_coverage.status).toBe("synthetic_only");
  });

  it("accepts an online stale region without an invented offline marker", () => {
    const value = fixture(["stale"]);
    const entry = syntheticObservation("stale");
    entry.connectivity = "online";
    entry.offline_marker = "";
    value.evidence.observations = [entry];
    expect(check(value).client_state_coverage.status).toBe("synthetic_only");
  });

  it("rejects an omitted offline marker on an offline stale region", () => {
    const value = fixture(["stale"]);
    const entry = syntheticObservation("stale");
    entry.offline_marker = "";
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:offline_marker");
  });

  it("rejects invented offline status from a failed online request", () => {
    const value = fixture(["offline"]);
    const entry = syntheticObservation("offline");
    entry.connectivity = "online";
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:offline_condition");
  });

  it("rejects error when the platform actually reports offline", () => {
    const value = fixture(["error"]);
    const entry = syntheticObservation("error");
    entry.connectivity = "offline";
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:offline_condition");
  });

  it("does not turn displayable stale data into the no-data offline state", () => {
    const value = fixture(["offline"]);
    const entry = syntheticObservation("offline");
    entry.data_display = "shown_marked";
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:data_display");
  });

  it("does not treat degraded retained content as a no-data error", () => {
    expect(definition("error").dataDisplay).toBe("none");
    expect(definition("degraded").dataDisplay).toBe("shown");
    const value = fixture(["degraded"]);
    const entry = syntheticObservation("degraded");
    entry.data_display = "none";
    value.evidence.observations = [entry];
    expect(() => check(value)).toThrow("client-state-gate:data_display");
  });
});
