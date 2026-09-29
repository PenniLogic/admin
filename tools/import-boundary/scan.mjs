// @ts-check
/**
 * Import-boundary scanner: enforces tools/import-boundary/policy.mjs over every source file, the
 * dependency manifest and the lockfile of a repository root.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

import {
  ABSOLUTE_OR_REMOTE_PATTERN,
  CUSTOMER_CODE_PATTERN,
  EXACT_VERSION_PATTERN,
  organizationRuleFor,
  packageNameOf,
  REGISTRY_URL_PREFIX,
  RULES,
} from "./policy.mjs";

/**
 * @typedef {{ rule: string, file: string, specifier: string, message: string }} Violation
 * @typedef {{ root: string, declared: ReadonlySet<string> }} Context
 * @typedef {Record<string, string> | undefined} DependencyMap
 * @typedef {{
 *   dependencies?: DependencyMap,
 *   devDependencies?: DependencyMap,
 *   optionalDependencies?: DependencyMap,
 *   peerDependencies?: DependencyMap,
 *   overrides?: unknown,
 *   workspaces?: unknown,
 *   bundleDependencies?: unknown,
 *   bundledDependencies?: unknown,
 * }} Manifest
 * @typedef {{ resolved?: unknown, integrity?: unknown, link?: unknown, dependencies?: DependencyMap, devDependencies?: DependencyMap }} LockEntry
 * @typedef {{ lockfileVersion?: unknown, packages?: Record<string, LockEntry> }} Lockfile
 */

export const SOURCE_EXTENSIONS = Object.freeze([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"]);

export const IGNORED_DIRECTORIES = Object.freeze(["node_modules", ".next", ".git", "coverage"]);

const STATIC_SPECIFIER = /\b(?:import|export)\s*(?:[\w*{}\s,$]*?\s*from\s*)?["']([^"'\n]+)["']/g;
const DYNAMIC_SPECIFIER = /\b(?:import|require)\s*\(\s*(["'`])([^"'`\n]+)\1\s*\)/g;
const NON_LITERAL_DYNAMIC = /\b(?:import|require)\s*\(\s*(?![\s"'`])([^)]*)\)/g;
/** @type {ReadonlyArray<"dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies">} */
const DEPENDENCY_FIELDS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);
/** @type {ReadonlyArray<"workspaces" | "bundleDependencies" | "bundledDependencies" | "overrides">} */
const SMUGGLING_FIELDS = Object.freeze(["workspaces", "bundleDependencies", "bundledDependencies", "overrides"]);
/** @type {ReadonlyArray<"dependencies" | "devDependencies">} */
const LOCKED_ROOT_FIELDS = Object.freeze(["dependencies", "devDependencies"]);
const BUILTINS = new Set(builtinModules);

/**
 * Extracts every literal static, dynamic and CommonJS import specifier from source text.
 * @param {string} source
 * @returns {string[]}
 */
export function extractSpecifiers(source) {
  const specifiers = [];
  for (const match of source.matchAll(STATIC_SPECIFIER)) {
    specifiers.push(/** @type {string} */ (match[1]));
  }
  for (const match of source.matchAll(DYNAMIC_SPECIFIER)) {
    specifiers.push(/** @type {string} */ (match[2]));
  }
  return specifiers;
}

/**
 * Extracts the argument text of every dynamic import or require whose specifier is not a literal.
 * @param {string} source
 * @returns {string[]}
 */
export function extractNonLiteralSpecifiers(source) {
  return [...source.matchAll(NON_LITERAL_DYNAMIC)].map((match) => /** @type {string} */ (match[1]).trim());
}

/**
 * @param {string} root
 * @param {string} candidate absolute path
 */
function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * @param {string} root
 * @param {string} candidate absolute path
 */
function resolvesToRepositoryFile(root, candidate) {
  return isInside(root, candidate) && !isInside(path.join(root, "node_modules"), candidate);
}

/**
 * Path a violation is attributed to: relative to the root, or verbatim when it is the root itself.
 * @param {string} root
 * @param {string} file
 */
function attributed(root, file) {
  return path.relative(root, file) || file;
}

/**
 * Checks one import specifier found in `file`.
 * @param {string} specifier
 * @param {string} file absolute path of the importing file
 * @param {Context} context
 * @returns {Violation | null}
 */
export function checkSpecifier(specifier, file, context) {
  const relativeFile = attributed(context.root, file);
  /** @param {string} rule @param {string} message */
  const violation = (rule, message) => ({ rule, file: relativeFile, specifier, message });

  if (specifier.includes("${")) {
    return violation(RULES.nonLiteralSpecifier, "Import specifiers must be string literals.");
  }
  if (ABSOLUTE_OR_REMOTE_PATTERN.test(specifier)) {
    return violation(RULES.absoluteOrRemote, "Absolute, URL and node_modules specifiers are refused.");
  }
  if (CUSTOMER_CODE_PATTERN.test(specifier)) {
    return violation(RULES.customerCode, "Customer web code and shared client bundles are never imported.");
  }
  if (specifier.startsWith("@/")) {
    const target = path.resolve(context.root, specifier.slice(2));
    return resolvesToRepositoryFile(context.root, target)
      ? null
      : violation(RULES.escapesRepository, "Alias import resolves outside this repository's own files.");
  }
  if (specifier.startsWith(".")) {
    const target = path.resolve(path.dirname(file), specifier);
    return resolvesToRepositoryFile(context.root, target)
      ? null
      : violation(RULES.escapesRepository, "Relative import resolves outside this repository's own files.");
  }
  if (specifier.startsWith("node:") || BUILTINS.has(specifier)) {
    return null;
  }
  const name = packageNameOf(specifier);
  const organizationRule = organizationRuleFor(name);
  if (organizationRule !== null) {
    return violation(organizationRule, `Package ${name} is refused by the admin import boundary.`);
  }
  if (!context.declared.has(name)) {
    return violation(RULES.undeclaredDependency, `Package ${name} is not declared in package.json.`);
  }
  return null;
}

/**
 * Checks every specifier of one source text.
 * @param {string} source
 * @param {string} file absolute path the source is attributed to
 * @param {Context} context
 * @returns {Violation[]}
 */
export function checkSource(source, file, context) {
  const violations = [];
  for (const specifier of extractSpecifiers(source)) {
    const found = checkSpecifier(specifier, file, context);
    if (found) {
      violations.push(found);
    }
  }
  for (const expression of extractNonLiteralSpecifiers(source)) {
    violations.push({
      rule: RULES.nonLiteralSpecifier,
      file: attributed(context.root, file),
      specifier: expression,
      message: "Dynamic import and require arguments must be string literals.",
    });
  }
  return violations;
}

/**
 * Names declared in every dependency field of a manifest.
 * @param {Manifest} manifest
 * @returns {Set<string>}
 */
export function declaredDependencies(manifest) {
  const names = new Set();
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Checks the dependency manifest for customer packages and non-registry provenance.
 * @param {Manifest} manifest
 * @returns {Violation[]}
 */
export function checkManifest(manifest) {
  /** @type {Violation[]} */
  const violations = [];
  /** @param {string} rule @param {string} specifier @param {string} message */
  const add = (rule, specifier, message) => violations.push({ rule, file: "package.json", specifier, message });

  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      const organizationRule = organizationRuleFor(name);
      if (organizationRule !== null) {
        add(organizationRule, `${field}.${name}`, "Refused package declared as a dependency.");
      }
      if (!EXACT_VERSION_PATTERN.test(version)) {
        add(RULES.nonRegistryDependency, `${field}.${name}=${version}`, "Only exact registry versions are permitted.");
      }
    }
  }
  for (const field of SMUGGLING_FIELDS) {
    if (field in manifest) {
      add(RULES.workspaceOrBundle, field, "Workspaces, bundled dependencies and overrides can smuggle undeclared code.");
    }
  }
  return violations;
}

/**
 * Checks that every locked package comes from the public registry and agrees with the manifest.
 * @param {Lockfile} lockfile
 * @param {Manifest} manifest
 * @returns {Violation[]}
 */
export function checkLockfile(lockfile, manifest) {
  /** @type {Violation[]} */
  const violations = [];
  /** @param {string} specifier @param {string} message */
  const add = (specifier, message) => violations.push({ rule: RULES.lockfile, file: "package-lock.json", specifier, message });

  if (lockfile.lockfileVersion !== 3) {
    add("lockfileVersion", "Expected an npm lockfile version 3.");
  }
  const packages = lockfile.packages ?? {};
  const rootEntry = packages[""] ?? {};
  for (const field of LOCKED_ROOT_FIELDS) {
    const locked = JSON.stringify(rootEntry[field] ?? {});
    const declared = JSON.stringify(manifest[field] ?? {});
    if (locked !== declared) {
      add(field, "Lockfile root entry does not match package.json.");
    }
  }
  for (const [key, entry] of Object.entries(packages)) {
    if (key === "") {
      continue;
    }
    const marker = key.lastIndexOf("node_modules/");
    const name = marker === -1 ? key : key.slice(marker + "node_modules/".length);
    if (!key.startsWith("node_modules/")) {
      add(key, "Only node_modules entries are permitted; workspace paths are refused.");
    }
    if (entry.link === true) {
      add(key, "Linked packages are refused.");
    }
    if (typeof entry.resolved !== "string" || !entry.resolved.startsWith(REGISTRY_URL_PREFIX)) {
      add(key, "Package must resolve to the public npm registry.");
    }
    if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
      add(key, "Package must carry a sha512 integrity hash.");
    }
    if (organizationRuleFor(name) !== null) {
      add(key, "Refused package present in the lockfile.");
    }
  }
  return violations;
}

/**
 * Lists source files under `root`, skipping dependency, build, VCS and coverage directories.
 * @param {string} root
 * @returns {string[]} absolute paths, sorted
 */
export function listSourceFiles(root) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} directory */
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.includes(entry.name)) {
          walk(full);
        }
      } else if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files.sort();
}

/**
 * @param {string} file
 * @returns {unknown}
 */
function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Scans a repository root: manifest, lockfile and every source file.
 * @param {string} root
 * @returns {{ root: string, files: string[], violations: Violation[] }}
 */
export function scanRepository(root) {
  const absoluteRoot = path.resolve(root);
  statSync(path.join(absoluteRoot, "package.json"));
  const manifest = /** @type {Manifest} */ (readJson(path.join(absoluteRoot, "package.json")));
  const lockfile = /** @type {Lockfile} */ (readJson(path.join(absoluteRoot, "package-lock.json")));
  const context = { root: absoluteRoot, declared: declaredDependencies(manifest) };
  const files = listSourceFiles(absoluteRoot);
  const violations = [...checkManifest(manifest), ...checkLockfile(lockfile, manifest)];
  for (const file of files) {
    violations.push(...checkSource(readFileSync(file, "utf8"), file, context));
  }
  return { root: absoluteRoot, files: files.map((file) => path.relative(absoluteRoot, file)), violations };
}
