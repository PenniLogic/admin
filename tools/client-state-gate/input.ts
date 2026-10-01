import ts from "typescript";

export function refuse(rule: string): never {
  throw new Error(`client-state-gate:${rule}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) refuse("object_required");
  return value;
}

export function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const result = record(value);
  if (required.some((key) => !Object.hasOwn(result, key))) refuse("missing_field");
  if (Object.keys(result).some((key) => !required.includes(key) && !optional.includes(key))) {
    refuse("unknown_field");
  }
  return result;
}

export function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) refuse("text_required");
  return value;
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) refuse("array_required");
  return value;
}

export function strings(value: unknown, allowEmpty = false): string[] {
  const result = array(value).map(text);
  if (!allowEmpty && result.length === 0) refuse("empty_list");
  if (new Set(result).size !== result.length) refuse("duplicate_identifier");
  return result;
}

export function parseJson(source: string): unknown {
  if (source.startsWith("\uFEFF")) refuse("malformed_json");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    if (error instanceof SyntaxError) refuse("malformed_json");
    throw error;
  }
  const syntax = ts.parseJsonText("client-state-input.json", source);
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const keys = new Set<string>();
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) refuse("malformed_json");
        if (keys.has(property.name.text)) refuse("duplicate_json_key");
        keys.add(property.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  return value;
}
