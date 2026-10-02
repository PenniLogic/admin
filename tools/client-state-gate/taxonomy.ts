import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { array, parseJson, record, refuse, strings, text } from "./input";

export const SOURCE_PIN = {
  repository: "PenniLogic/docs",
  issue: "https://github.com/PenniLogic/docs/issues/1",
  commit: "a700e639585c61a4610e7b99dbd02b2dab28bdcc",
  tree: "3879d3893a3f289bd6b0d4474f09dbebf1fef195",
  taxonomy_version: "1.1.0",
  schema_version: 1,
  data: {
    path: "product/client-state-taxonomy.json",
    git_blob: "47c3b234fb3921cdd5057a77d95610d72da0805a",
    sha256: "040d2f0c27332ce3f6794a90139e714b3c50afb5b7340aa596d47b8866f2b3fb",
    bytes: 78795,
  },
  schema: {
    path: "product/client-state-taxonomy.schema.json",
    git_blob: "703c67f535852d91cf06f6b585b083dbdb1901c9",
    sha256: "6bceee452e135835baa7733886d3aceae6322df5a6aefc0c9ea9f9d35ddebfc1",
    bytes: 21422,
  },
  document: {
    path: "product/client-state-taxonomy.md",
    git_blob: "2a3b35572bfda0040e313e912f6ff6224c03469d",
    sha256: "7d8fc9d415c18c90c715726c09f93dc7774527dd17ea42a5a4b0a3587f172717",
    bytes: 74054,
  },
} as const;

export const QUALITY_DIRECTORY = new URL("../../quality/client-state-taxonomy/", import.meta.url);

export interface CanonicalCopy {
  readonly headline: string;
  readonly body: string;
}

export interface StateDefinition {
  readonly id: string;
  readonly scopes: readonly string[];
  readonly dataDisplay: string;
  readonly copy: CanonicalCopy;
  readonly variants: ReadonlyMap<string, CanonicalCopy>;
  readonly recoveryId: string;
  readonly recoveryLabel: string;
  readonly labelsByCause: ReadonlyMap<string, string>;
  readonly labelsByVariant: ReadonlyMap<string, string>;
  readonly causes: readonly string[];
  readonly guarantees: ReadonlyMap<string, boolean>;
}

export interface Taxonomy {
  readonly version: string;
  readonly clients: readonly string[];
  readonly scopes: readonly string[];
  readonly dataDisplays: readonly string[];
  readonly states: ReadonlyMap<string, StateDefinition>;
  readonly placeholders: ReadonlyMap<string, string>;
  readonly forbiddenTerms: readonly string[];
  readonly registrationRequired: readonly string[];
  readonly registrationProperties: readonly string[];
  readonly assertionIds: readonly string[];
}

function exactPin(actual: unknown, expected: unknown): void {
  if (typeof expected !== "object" || expected === null) {
    if (actual !== expected) refuse("source_pin");
    return;
  }
  const expectedObject = record(expected);
  const actualObject = record(actual);
  if (Object.keys(actualObject).length !== Object.keys(expectedObject).length) refuse("source_pin");
  for (const [key, value] of Object.entries(expectedObject)) {
    if (!Object.hasOwn(actualObject, key)) refuse("source_pin");
    exactPin(actualObject[key], value);
  }
}

function verifyBytes(bytes: Uint8Array, pin: typeof SOURCE_PIN.data | typeof SOURCE_PIN.schema): void {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const gitBlob = createHash("sha1").update(`blob ${String(bytes.length)}\0`).update(bytes).digest("hex");
  if (bytes.length !== pin.bytes || sha256 !== pin.sha256 || gitBlob !== pin.git_blob) refuse("pinned_bytes");
}

function copy(value: unknown): CanonicalCopy {
  const entry = record(value);
  return { headline: text(entry["headline"]), body: text(entry["body"]) };
}

function textMap(value: unknown): ReadonlyMap<string, string> {
  if (value === undefined) return new Map();
  return new Map(Object.entries(record(value)).map(([key, item]) => [key, text(item)]));
}

function state(value: unknown): StateDefinition {
  const entry = record(value);
  const canonical = record(entry["copy"]);
  const recovery = record(entry["recovery_action"]);
  const variants = canonical["variants"] === undefined ? {} : record(canonical["variants"]);
  const guarantees = entry["guarantees"] === undefined ? {} : record(entry["guarantees"]);
  return {
    id: text(entry["id"]),
    scopes: strings(entry["scopes"]),
    dataDisplay: text(entry["data_display"]),
    copy: copy(canonical),
    variants: new Map(Object.entries(variants).map(([key, item]) => [key, copy(item)])),
    recoveryId: text(recovery["id"]),
    recoveryLabel: text(recovery["label"]),
    labelsByCause: textMap(recovery["label_by_cause"]),
    labelsByVariant: textMap(recovery["label_by_variant"]),
    causes: entry["causes"] === undefined
      ? []
      : strings(array(entry["causes"]).map((cause) => text(record(cause)["id"]))),
    guarantees: new Map(Object.entries(guarantees).map(([key, item]) => {
      if (typeof item !== "boolean") refuse("state_guarantees");
      return [key, item];
    })),
  };
}

export function verifyPinnedTaxonomy(files: {
  readonly data: Uint8Array;
  readonly schema: Uint8Array;
  readonly source: string;
}): Taxonomy {
  exactPin(parseJson(files.source), SOURCE_PIN);
  verifyBytes(files.data, SOURCE_PIN.data);
  verifyBytes(files.schema, SOURCE_PIN.schema);
  const data = record(parseJson(Buffer.from(files.data).toString("utf8")));
  const schema = record(parseJson(Buffer.from(files.schema).toString("utf8")));
  if (data["taxonomy_version"] !== SOURCE_PIN.taxonomy_version || data["schema_version"] !== SOURCE_PIN.schema_version) {
    refuse("taxonomy_version");
  }
  const definitions = record(schema["definitions"]);
  const registration = record(definitions["surface_registration"]);
  const states = array(data["states"]).map(state);
  const stateMap = new Map(states.map((entry) => [entry.id, entry]));
  if (stateMap.size !== states.length || states.length !== 8) refuse("taxonomy_identifiers");
  const placeholders = array(data["placeholders"]).map((value) => {
    const entry = record(value);
    return { id: text(entry["id"]), source: text(entry["source"]) };
  });
  const placeholderMap = new Map(placeholders.map((entry) => [entry.id, entry.source]));
  if (placeholderMap.size !== placeholders.length) refuse("taxonomy_identifiers");
  const assertions = array(record(data["adoption"])["coverage_assertions"]).map((value) => text(record(value)["id"]));
  if (!assertions.includes("taxonomy_first") || !assertions.includes("client_state_coverage")) refuse("taxonomy_assertions");
  return {
    version: text(data["taxonomy_version"]),
    clients: strings(data["clients"]),
    scopes: Object.keys(record(data["scopes"])),
    dataDisplays: Object.keys(record(data["data_display_values"])),
    states: stateMap,
    placeholders: placeholderMap,
    forbiddenTerms: strings(data["forbidden_terms"]),
    registrationRequired: strings(registration["required"]),
    registrationProperties: Object.keys(record(registration["properties"])),
    assertionIds: strings(assertions),
  };
}

export function readJsonFile(file: URL): unknown {
  return parseJson(readFileSync(file, "utf8"));
}

export function readPinnedTaxonomy(directory: URL = QUALITY_DIRECTORY): Taxonomy {
  return verifyPinnedTaxonomy({
    data: readFileSync(new URL("client-state-taxonomy.json", directory)),
    schema: readFileSync(new URL("client-state-taxonomy.schema.json", directory)),
    source: readFileSync(new URL("source.json", directory), "utf8"),
  });
}
