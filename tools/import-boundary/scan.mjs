// @ts-check
/**
 * Import-boundary scanner: enforces tools/import-boundary/policy.mjs over every source file, the
 * dependency manifest, the lockfile and the resolution configuration of a repository root.
 *
 * Source is parsed with the TypeScript compiler, never matched with regular expressions, so every
 * static import, re-export, `import x = require()`, `import("x")` type, dynamic `import()` and
 * `require()` is seen exactly as the compiler sees it. Any dynamic argument that is not a single
 * string literal, and any identifier that could assemble a specifier at run time, is refused.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

import ts from "typescript";

import {
  ABSOLUTE_OR_REMOTE_PATTERN,
  CUSTOMER_CODE_PATTERN,
  EXACT_VERSION_PATTERN,
  INDIRECT_LOADER_IDENTIFIERS,
  INDIRECT_LOADER_PROPERTIES,
  NEXT_CONFIG_ALLOWED_KEYS,
  organizationRuleFor,
  packageNameOf,
  REGISTRY_URL_PREFIX,
  RULES,
  TSCONFIG_PINNED_PATHS,
  TSCONFIG_REFUSED_KEYS,
  TSCONFIG_REFUSED_OPTIONS,
} from "./policy.mjs";

/**
 * @typedef {{ rule: string, file: string, specifier: string, message: string, line?: number }} Violation
 * @typedef {{ root: string, declared: ReadonlySet<string> }} Context
 * @typedef {{ specifier: string, line: number }} Located
 * @typedef {{ specifiers: Located[], nonLiteral: Located[], loaders: Located[] }} ParsedImports
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
 *   imports?: unknown,
 * }} Manifest
 * @typedef {{ resolved?: unknown, integrity?: unknown, link?: unknown, dependencies?: DependencyMap, devDependencies?: DependencyMap }} LockEntry
 * @typedef {{ lockfileVersion?: unknown, packages?: Record<string, LockEntry> }} Lockfile
 * @typedef {{ files: string[], links: string[] }} Walk
 */

export const SOURCE_EXTENSIONS = Object.freeze([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"]);

export const IGNORED_DIRECTORIES = Object.freeze(["node_modules", ".next", ".git", "coverage"]);

/** @type {ReadonlyArray<"dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies">} */
const DEPENDENCY_FIELDS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);
/** @type {ReadonlyArray<"workspaces" | "bundleDependencies" | "bundledDependencies" | "overrides" | "imports">} */
const SMUGGLING_FIELDS = Object.freeze(["workspaces", "bundleDependencies", "bundledDependencies", "overrides", "imports"]);
/** @type {ReadonlyArray<"dependencies" | "devDependencies">} */
const LOCKED_ROOT_FIELDS = Object.freeze(["dependencies", "devDependencies"]);
const BUILTINS = new Set(builtinModules);

/**
 * @param {string} fileName
 * @returns {ts.ScriptKind}
 */
function scriptKindFor(fileName) {
  switch (path.extname(fileName).toLowerCase()) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

/**
 * @param {ts.Node} node
 * @returns {string | null} the literal text when the node is a plain string literal
 */
function literalText(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

/**
 * @param {ts.Expression} callee
 * @returns {string | null} the refused property access, if this callee is one
 */
function indirectLoaderProperty(callee) {
  if (!ts.isPropertyAccessExpression(callee)) {
    return null;
  }
  const object = callee.expression;
  const objectText = ts.isIdentifier(object) ? object.text : ts.isMetaProperty(object) ? "import.meta" : null;
  const access = objectText === null ? null : `${objectText}.${callee.name.text}`;
  return access !== null && INDIRECT_LOADER_PROPERTIES.includes(access) ? access : null;
}

/**
 * Parses source text and collects every module specifier, every dynamic import or require whose
 * argument list is not exactly one string literal, and every indirect loader.
 * @param {string} source
 * @param {string} fileName decides the script kind (.ts, .tsx, .mjs, ...)
 * @returns {ParsedImports}
 */
export function parseImports(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  /** @type {ParsedImports} */
  const parsed = { specifiers: [], nonLiteral: [], loaders: [] };
  /** @param {number} position */
  const lineAt = (position) => sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  /** @param {ts.Node} node */
  const textOf = (node) => node.getText(sourceFile);
  /** @param {string} text @param {number} position */
  const specifier = (text, position) => parsed.specifiers.push({ specifier: text, line: lineAt(position) });
  /** @param {ts.Node} node */
  const nonLiteral = (node) => parsed.nonLiteral.push({ specifier: textOf(node), line: lineAt(node.getStart(sourceFile)) });
  /** @param {string} text @param {ts.Node} node */
  const loader = (text, node) => parsed.loaders.push({ specifier: text, line: lineAt(node.getStart(sourceFile)) });
  /**
   * Static declarations only ever carry string literals (the grammar rejects anything else), so a
   * non-literal here is unreachable; the dynamic forms are classified in the call-expression branch.
   * @param {ts.Node} literal
   */
  const staticSpecifier = (literal) => specifier(literalText(literal) ?? textOf(literal), literal.getStart(sourceFile));

  for (const reference of [...sourceFile.referencedFiles, ...sourceFile.typeReferenceDirectives]) {
    specifier(reference.fileName, reference.pos);
  }
  for (const dependency of sourceFile.amdDependencies) {
    specifier(dependency.path, 0);
  }

  /** @param {ts.Node} node */
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      staticSpecifier(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      staticSpecifier(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      staticSpecifier(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const property = indirectLoaderProperty(callee);
      if (isDynamicImport || isRequire) {
        const [argument] = node.arguments;
        const literal = node.arguments.length === 1 && argument !== undefined ? literalText(argument) : null;
        if (literal === null) {
          nonLiteral(node);
        } else {
          specifier(literal, node.getStart(sourceFile));
        }
      } else if (property !== null) {
        loader(property, node);
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      loader("new Function", node);
    } else if (ts.isIdentifier(node) && INDIRECT_LOADER_IDENTIFIERS.includes(node.text)) {
      loader(node.text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return parsed;
}

/**
 * Every literal specifier of a source text, in source order.
 * @param {string} source
 * @param {string} [fileName]
 * @returns {string[]}
 */
export function extractSpecifiers(source, fileName = "source.ts") {
  return parseImports(source, fileName).specifiers.map((entry) => entry.specifier);
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
 * Canonical location of a path that may not exist yet: the real path of its deepest existing
 * ancestor plus the remaining segments, so symbolic links and junctions on the way are resolved.
 * @param {string} target absolute path
 * @returns {string}
 */
export function canonical(target) {
  let existing = target;
  let rest = "";
  // The filesystem root always exists, so the walk terminates.
  while (!existsSync(existing)) {
    rest = rest === "" ? path.basename(existing) : path.join(path.basename(existing), rest);
    existing = path.dirname(existing);
  }
  const real = realpathSync.native(existing);
  return rest === "" ? real : path.join(real, rest);
}

/**
 * @param {string} root
 * @param {string} candidate absolute path
 */
function resolvesToRepositoryFile(root, candidate) {
  const realRoot = canonical(root);
  const realCandidate = canonical(candidate);
  return isInside(realRoot, realCandidate) && !isInside(path.join(realRoot, "node_modules"), realCandidate);
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
 * Checks one literal import specifier found in `file`.
 * @param {string} specifier
 * @param {string} file absolute path of the importing file
 * @param {Context} context
 * @returns {Violation | null}
 */
export function checkSpecifier(specifier, file, context) {
  const relativeFile = attributed(context.root, file);
  /** @param {string} rule @param {string} message */
  const violation = (rule, message) => ({ rule, file: relativeFile, specifier, message });

  if (ABSOLUTE_OR_REMOTE_PATTERN.test(specifier)) {
    return violation(RULES.absoluteOrRemote, "Absolute, URL, node_modules and subpath-import specifiers are refused.");
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
 * Checks every import of one source text.
 * @param {string} source
 * @param {string} file absolute path the source is attributed to
 * @param {Context} context
 * @returns {Violation[]}
 */
export function checkSource(source, file, context) {
  /** @type {Violation[]} */
  const violations = [];
  const relativeFile = attributed(context.root, file);
  const parsed = parseImports(source, file);
  for (const { specifier, line } of parsed.specifiers) {
    const found = checkSpecifier(specifier, file, context);
    if (found) {
      violations.push({ ...found, line });
    }
  }
  for (const { specifier, line } of parsed.nonLiteral) {
    violations.push({
      rule: RULES.nonLiteralSpecifier,
      file: relativeFile,
      specifier,
      message: "Dynamic import and require arguments must be exactly one string literal.",
      line,
    });
  }
  for (const { specifier, line } of parsed.loaders) {
    violations.push({
      rule: RULES.indirectLoader,
      file: relativeFile,
      specifier,
      message: "Indirect module loaders and code evaluation are refused.",
      line,
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
      add(RULES.workspaceOrBundle, field, "Workspaces, bundled dependencies, overrides and subpath imports can smuggle undeclared code.");
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
 * Checks the TypeScript configuration: the path mapping is pinned and nothing relocates resolution.
 * @param {unknown} tsconfig parsed tsconfig.json, or undefined when the file is missing
 * @returns {Violation[]}
 */
export function checkTsconfig(tsconfig) {
  /** @type {Violation[]} */
  const violations = [];
  /** @param {string} specifier @param {string} message */
  const add = (specifier, message) => violations.push({ rule: RULES.resolutionSurface, file: "tsconfig.json", specifier, message });

  if (typeof tsconfig !== "object" || tsconfig === null) {
    add("tsconfig.json", "A tsconfig.json with the pinned path mapping is required.");
    return violations;
  }
  const config = /** @type {Record<string, unknown>} */ (tsconfig);
  for (const key of TSCONFIG_REFUSED_KEYS) {
    if (key in config) {
      add(key, "Configuration and file lists must not be pulled from elsewhere.");
    }
  }
  const rawOptions = config["compilerOptions"];
  const options = /** @type {Record<string, unknown>} */ (typeof rawOptions === "object" && rawOptions !== null ? rawOptions : {});
  for (const option of TSCONFIG_REFUSED_OPTIONS) {
    if (option in options) {
      add(`compilerOptions.${option}`, "Compiler options that relocate module resolution are refused.");
    }
  }
  if (JSON.stringify(options["paths"]) !== JSON.stringify(TSCONFIG_PINNED_PATHS)) {
    add("compilerOptions.paths", `Path mapping must be exactly ${JSON.stringify(TSCONFIG_PINNED_PATHS)}.`);
  }
  const include = Array.isArray(config["include"]) ? config["include"] : [];
  for (const pattern of include) {
    if (typeof pattern !== "string" || pattern.startsWith("..") || path.isAbsolute(pattern) || ABSOLUTE_OR_REMOTE_PATTERN.test(pattern)) {
      add(`include.${String(pattern)}`, "Included files must live inside this repository.");
    }
  }
  return violations;
}

/**
 * Checks next.config.ts: a plain object literal whose keys are all allowed, with no calls, spreads,
 * computed names or plugin wrappers that could introduce a resolution surface.
 * @param {string} source
 * @returns {Violation[]}
 */
export function checkNextConfig(source) {
  /** @type {Violation[]} */
  const violations = [];
  const sourceFile = ts.createSourceFile("next.config.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  /** @param {ts.Node} node @param {string} specifier @param {string} message */
  const add = (node, specifier, message) =>
    violations.push({
      rule: RULES.resolutionSurface,
      file: "next.config.ts",
      specifier,
      message,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    });

  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      add(node, node.getText(sourceFile), "next.config.ts must not call anything; plugins and wrappers are refused.");
    } else if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) {
      add(node, node.getText(sourceFile), "Spreads can introduce unreviewed configuration keys.");
    } else if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node)) {
      const name = node.name;
      const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
      if (key === null) {
        add(node, node.getText(sourceFile), "Computed configuration keys are refused.");
      } else if (!NEXT_CONFIG_ALLOWED_KEYS.includes(key)) {
        add(node, key, `Configuration key is not in the reviewed allowlist: ${NEXT_CONFIG_ALLOWED_KEYS.join(", ")}.`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

/**
 * Lists source files under `root`, skipping dependency, build, VCS and coverage directories, and
 * reports every symbolic link or junction so the scan fails closed instead of following it.
 * @param {string} root
 * @returns {Walk} absolute file paths and link paths, each sorted
 */
export function listSourceFiles(root) {
  /** @type {Walk} */
  const walk = { files: [], links: [] };
  /** @param {string} directory */
  const descend = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        walk.links.push(full);
      } else if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.includes(entry.name)) {
          descend(full);
        }
      } else if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
        walk.files.push(full);
      }
    }
  };
  descend(root);
  walk.files.sort();
  walk.links.sort();
  return walk;
}

/**
 * @param {string} file
 * @returns {unknown}
 */
function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * @param {string} file
 * @returns {unknown} parsed tsconfig (comments allowed), or undefined when the file is missing or invalid
 */
function readTsconfig(file) {
  if (!existsSync(file)) {
    return undefined;
  }
  const result = ts.parseConfigFileTextToJson(file.split(path.sep).join("/"), readFileSync(file, "utf8"));
  return result.error ? undefined : result.config;
}

/**
 * Scans a repository root: manifest, lockfile, resolution configuration and every source file.
 * @param {string} root
 * @returns {{ root: string, files: string[], violations: Violation[] }}
 */
export function scanRepository(root) {
  const absoluteRoot = path.resolve(root);
  const manifest = /** @type {Manifest} */ (readJson(path.join(absoluteRoot, "package.json")));
  const lockfile = /** @type {Lockfile} */ (readJson(path.join(absoluteRoot, "package-lock.json")));
  const context = { root: absoluteRoot, declared: declaredDependencies(manifest) };
  const walk = listSourceFiles(absoluteRoot);
  const nextConfig = path.join(absoluteRoot, "next.config.ts");
  const violations = [
    ...checkManifest(manifest),
    ...checkLockfile(lockfile, manifest),
    ...checkTsconfig(readTsconfig(path.join(absoluteRoot, "tsconfig.json"))),
    ...(existsSync(nextConfig) ? checkNextConfig(readFileSync(nextConfig, "utf8")) : []),
  ];
  for (const link of walk.links) {
    violations.push({
      rule: RULES.escapesRepository,
      file: attributed(absoluteRoot, link),
      specifier: attributed(absoluteRoot, link),
      message: "Symbolic links and junctions are refused inside the repository.",
    });
  }
  for (const file of walk.files) {
    violations.push(...checkSource(readFileSync(file, "utf8"), file, context));
  }
  return { root: absoluteRoot, files: walk.files.map((file) => path.relative(absoluteRoot, file)), violations };
}
