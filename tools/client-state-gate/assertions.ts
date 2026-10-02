import { array, object, record, refuse, strings, text } from "./input";
import { QUALITY_DIRECTORY, readJsonFile, readPinnedTaxonomy } from "./taxonomy";
import type { CanonicalCopy, StateDefinition, Taxonomy } from "./taxonomy";

const CURRENCY_CODE = `(?:${Intl.supportedValuesOf("currency").join("|")})`;
const NUMERIC_AMOUNT = "[+-]?\\d+(?:[.,]\\d+)*";
const CODE_MONEY = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${CURRENCY_CODE}\\s*${NUMERIC_AMOUNT}|${NUMERIC_AMOUNT}\\s*${CURRENCY_CODE})(?![\\p{L}\\p{N}_])`,
  "u",
);

const PLURAL_AVAILABILITY_CLAUSES = new Set([
  "answers", "items", "records", "reports", "tools",
  "saved answers", "saved items", "saved records", "saved reports",
  "your saved answers", "your saved items", "your saved records", "your saved reports",
  "manual tools", "local records",
]);
const COORDINATED_AVAILABILITY_CLAUSES = new Set(["manual entry", "navigation", "everything outside ai"]);

interface Surface {
  readonly id: string;
  readonly applicableStates: readonly string[];
  readonly copyValues: ReadonlyMap<string, string>;
  readonly capabilities: readonly string[];
}

export interface EnumerationResult {
  readonly assertion: "taxonomy_first";
  readonly status: "not_exercised" | "subset_checked";
  readonly checked_identifiers: number;
}

export interface CoverageResult {
  readonly assertion: "client_state_coverage";
  readonly status: "not_exercised" | "synthetic_only" | "observations_checked";
  readonly evidence_kind: "not_exercised" | "synthetic" | "rendered_observation";
  readonly registered_surfaces: number;
  readonly observed_states: number;
}

export interface GateResult {
  readonly taxonomy_first: EnumerationResult;
  readonly client_state_coverage: CoverageResult;
}

function adminVersion(taxonomy: Taxonomy, value: Record<string, unknown>): void {
  if (value["client"] !== "admin" || !taxonomy.clients.includes("admin")) refuse("client");
  if (value["taxonomy_version"] !== taxonomy.version) refuse("taxonomy_version");
}

function safeCopyText(taxonomy: Taxonomy, value: unknown): string {
  const result = text(value);
  if (/\p{Cc}|[{}<>]|\p{Sc}|https?:|@[a-z0-9-]+\./iu.test(result)) refuse("unsafe_copy");
  if (CODE_MONEY.test(result)) refuse("money_copy");
  for (const term of taxonomy.forbiddenTerms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(term === "!" ? escaped : `\\b${escaped}\\b`, "i").test(result)) refuse("forbidden_copy");
  }
  return result;
}

function qualifyAvailability(value: string): void {
  const clauses = value.toLowerCase().split(" and ");
  if (clauses.length === 1) {
    if (!PLURAL_AVAILABILITY_CLAUSES.has(value.toLowerCase())) refuse("plural_availability");
    return;
  }
  if (new Set(clauses).size !== clauses.length || clauses.some((clause) =>
    !PLURAL_AVAILABILITY_CLAUSES.has(clause) && !COORDINATED_AVAILABILITY_CLAUSES.has(clause),
  )) refuse("plural_availability");
}

export function taxonomyFirst(taxonomy: Taxonomy, enumeration: unknown): EnumerationResult {
  const identifiers = strings(enumeration, true);
  if (identifiers.some((id) => !taxonomy.states.has(id))) refuse("taxonomy_first");
  return {
    assertion: "taxonomy_first",
    status: identifiers.length === 0 ? "not_exercised" : "subset_checked",
    checked_identifiers: identifiers.length,
  };
}

function surface(taxonomy: Taxonomy, value: unknown, enumeration: readonly string[]): Surface {
  const entry = object(
    value,
    taxonomy.registrationRequired,
    taxonomy.registrationProperties.filter((key) => !taxonomy.registrationRequired.includes(key)),
  );
  if (entry["client"] !== "admin") refuse("client");
  const id = text(entry["surface_id"]);
  if (!/^[a-z][a-z0-9_]*$/.test(id)) refuse("surface_identifier");
  const applicableStates = strings(entry["applicable_states"]);
  taxonomyFirst(taxonomy, applicableStates);
  if (applicableStates.some((state) => !enumeration.includes(state))) refuse("unlisted_client_state");
  const copyValues = new Map<string, string>();
  for (const [key, item] of Object.entries(entry)) {
    if (!["surface_id", "client", "applicable_states", "capabilities", "freshness_window_seconds"].includes(key)) {
      const copyValue = safeCopyText(taxonomy, item);
      if (key === "still_available") qualifyAvailability(copyValue);
      copyValues.set(key, copyValue);
    }
  }
  const capabilities = entry["capabilities"] === undefined
    ? []
    : strings(entry["capabilities"]).map((item) => safeCopyText(taxonomy, item));
  const freshness = entry["freshness_window_seconds"];
  if (freshness !== undefined && (typeof freshness !== "number" || !Number.isSafeInteger(freshness) || freshness <= 0)) {
    refuse("freshness_window");
  }
  return { id, applicableStates, copyValues, capabilities };
}

function selection(state: StateDefinition, observation: Record<string, unknown>): {
  copy: CanonicalCopy;
  label: string;
  cause: string;
  variant: string;
} {
  const cause = observation["cause"] === undefined ? "" : text(observation["cause"]);
  const variant = observation["variant"] === undefined ? "" : text(observation["variant"]);
  if (cause !== "") {
    if (variant !== "" || !state.causes.includes(cause)) refuse("cause");
    const canonical = state.variants.get(cause);
    const label = state.labelsByCause.get(cause);
    if (canonical === undefined || label === undefined) refuse("cause_binding");
    return { copy: canonical, label, cause, variant };
  }
  if (variant !== "") {
    if (state.causes.includes(variant)) refuse("cause_required");
    const canonical = state.variants.get(variant);
    if (canonical === undefined) refuse("copy_variant");
    if (variant === "validation" && observation["scope"] !== "action") refuse("validation_scope");
    return { copy: canonical, label: state.labelsByVariant.get(variant) ?? state.recoveryLabel, cause, variant };
  }
  return { copy: state.copy, label: state.recoveryLabel, cause, variant };
}

function placeholderValues(
  taxonomy: Taxonomy,
  registration: Surface,
  value: unknown,
  templates: readonly string[],
): ReadonlyMap<string, string> {
  const used = [...new Set(templates.flatMap((template) =>
    [...template.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((match) => text(match[1])),
  ))];
  const supplied = object(value, used);
  const values = new Map<string, string>();
  for (const id of used) {
    const source = taxonomy.placeholders.get(id);
    if (source === undefined) refuse("placeholder");
    const entry = object(supplied[id], ["source", "value"]);
    if (entry["source"] !== source) refuse("placeholder_source");
    const rendered = safeCopyText(taxonomy, entry["value"]);
    if (id === "still_available") qualifyAvailability(rendered);
    if (source === "surface_registration") {
      if (id === "capability") {
        if (!registration.capabilities.includes(rendered)) refuse("registered_placeholder");
      } else if (registration.copyValues.get(id) !== rendered) {
        refuse("registered_placeholder");
      }
    }
    values.set(id, rendered);
  }
  return values;
}

function render(template: string, values: ReadonlyMap<string, string>): string {
  return template.replace(/\{([a-z][a-z0-9_]*)\}/g, (_match: string, id: string) => {
    const value = values.get(id);
    if (value === undefined) refuse("placeholder");
    return value;
  });
}

function observation(
  taxonomy: Taxonomy,
  value: unknown,
  registrations: ReadonlyMap<string, Surface>,
): { key: string; surface: string; state: string } {
  const entry = object(value, [
    "surface_id", "client", "taxonomy_version", "state", "scope", "copy", "recovery_actions",
    "placeholders", "data_display", "connectivity", "offline_marker", "guarantees",
  ], ["cause", "variant"]);
  adminVersion(taxonomy, entry);
  const surfaceId = text(entry["surface_id"]);
  const registration = registrations.get(surfaceId);
  if (registration === undefined) refuse("unregistered_surface");
  const stateId = text(entry["state"]);
  const state = taxonomy.states.get(stateId);
  if (state === undefined) refuse("taxonomy_first");
  if (!registration.applicableStates.includes(stateId)) refuse("inapplicable_state");
  const scope = text(entry["scope"]);
  if (!taxonomy.scopes.includes(scope) || !state.scopes.includes(scope)) refuse("state_scope");
  if (!taxonomy.dataDisplays.includes(text(entry["data_display"])) || entry["data_display"] !== state.dataDisplay) {
    refuse("data_display");
  }
  const connectivity = text(entry["connectivity"]);
  if (!["online", "offline", "unknown"].includes(connectivity)) refuse("connectivity");
  if ((stateId === "offline" && connectivity !== "offline") || (stateId === "error" && connectivity === "offline")) {
    refuse("offline_condition");
  }
  const selected = selection(state, entry);
  if (stateId === "error" && selected.variant !== "validation" && connectivity !== "online") {
    refuse("error_connectivity");
  }
  const values = placeholderValues(taxonomy, registration, entry["placeholders"], [
    selected.copy.headline, selected.copy.body, selected.label,
  ]);
  const rendered = object(entry["copy"], ["headline", "body"]);
  if (safeCopyText(taxonomy, rendered["headline"]) !== render(selected.copy.headline, values)
    || safeCopyText(taxonomy, rendered["body"]) !== render(selected.copy.body, values)) {
    refuse("canonical_copy");
  }
  const actions = array(entry["recovery_actions"]);
  if (actions.length !== 1) refuse("one_recovery_action");
  const action = object(actions[0], ["id", "label"]);
  if (action["id"] !== state.recoveryId || safeCopyText(taxonomy, action["label"]) !== render(selected.label, values)) {
    refuse("canonical_recovery");
  }
  const guarantees = object(entry["guarantees"], [...state.guarantees.keys()]);
  for (const [key, expected] of state.guarantees) {
    if (guarantees[key] !== expected) refuse("state_guarantees");
  }
  const offline = taxonomy.states.get("offline");
  if (offline === undefined) refuse("taxonomy_identifiers");
  const marker = stateId === "stale" && connectivity === "offline" ? offline.copy.headline : "";
  if (entry["offline_marker"] !== marker) refuse("offline_marker");
  return {
    key: [surfaceId, stateId, scope, selected.cause, selected.variant].join(":"),
    surface: surfaceId,
    state: stateId,
  };
}

export function clientStateCoverage(taxonomy: Taxonomy, registryValue: unknown, evidenceValue: unknown): CoverageResult {
  const registry = object(registryValue, [
    "gate_schema_version", "client", "taxonomy_version", "coverage_status", "client_states", "surfaces",
  ]);
  const evidence = object(evidenceValue, [
    "gate_schema_version", "client", "taxonomy_version", "evidence_kind", "observations",
  ]);
  if (registry["gate_schema_version"] !== 1 || evidence["gate_schema_version"] !== 1) refuse("gate_schema_version");
  adminVersion(taxonomy, registry);
  adminVersion(taxonomy, evidence);
  taxonomyFirst(taxonomy, registry["client_states"]);
  const enumeration = strings(registry["client_states"], true);
  const surfaces = array(registry["surfaces"]).map((entry) => surface(taxonomy, entry, enumeration));
  const registrations = new Map(surfaces.map((entry) => [entry.id, entry]));
  if (registrations.size !== surfaces.length) refuse("duplicate_surface");
  const observations = array(evidence["observations"]);
  const kind = text(evidence["evidence_kind"]);
  if (surfaces.length === 0) {
    if (registry["coverage_status"] !== "not_exercised" || kind !== "not_exercised" || observations.length !== 0) {
      refuse("unexercised_evidence");
    }
    return {
      assertion: "client_state_coverage", status: "not_exercised", evidence_kind: kind,
      registered_surfaces: 0, observed_states: 0,
    };
  }
  if (registry["coverage_status"] !== "registered" || (kind !== "synthetic" && kind !== "rendered_observation")) {
    refuse("evidence_kind");
  }
  if (surfaces.some((entry) => kind === "synthetic"
    ? !entry.id.startsWith("synthetic_")
    : /^(?:synthetic|example)_/.test(entry.id))) refuse("evidence_boundary");
  const checked = observations.map((entry) => observation(taxonomy, entry, registrations));
  if (new Set(checked.map((entry) => entry.key)).size !== checked.length) refuse("duplicate_observation");
  for (const registration of surfaces) {
    for (const state of registration.applicableStates) {
      if (!checked.some((entry) => entry.surface === registration.id && entry.state === state)) refuse("missing_state");
    }
  }
  return {
    assertion: "client_state_coverage",
    status: kind === "synthetic" ? "synthetic_only" : "observations_checked",
    evidence_kind: kind,
    registered_surfaces: registrations.size,
    observed_states: checked.length,
  };
}

export function checkClientStateGate(taxonomy: Taxonomy, registryValue: unknown, evidenceValue: unknown): GateResult {
  const registry = record(registryValue);
  const coverage = clientStateCoverage(taxonomy, registry, evidenceValue);
  return { taxonomy_first: taxonomyFirst(taxonomy, registry["client_states"]), client_state_coverage: coverage };
}

export function readNativeClientStateGate(): GateResult {
  return checkClientStateGate(
    readPinnedTaxonomy(),
    readJsonFile(new URL("registry.json", QUALITY_DIRECTORY)),
    readJsonFile(new URL("evidence.json", QUALITY_DIRECTORY)),
  );
}
