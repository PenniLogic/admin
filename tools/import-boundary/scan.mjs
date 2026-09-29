// @ts-check
/**
 * Import-boundary scanner: enforces tools/import-boundary/policy.mjs over every source file, the
 * dependency manifest, the lockfile and the resolution configuration of a repository root.
 *
 * Source is parsed with the TypeScript compiler, never matched with regular expressions, so every
 * static import, re-export, `import x = require()`, `import("x")` type, dynamic `import()` and
 * `require()` is seen exactly as the compiler sees it. What is enforced is enumerated: literal-only
 * dynamic specifiers, no reference to the listed loader names, no computed member access on the
 * listed bindings, `require` only as a direct callee, and for runtime source a positive allowlist of
 * imports plus no reference to any process, global, module-system, network or timer identifier.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

import ts from "typescript";

import {
  ABSOLUTE_OR_REMOTE_PATTERN,
  COMPUTED_ACCESS_REFUSED_OBJECTS,
  CUSTOMER_CODE_PATTERN,
  EXACT_VERSION_PATTERN,
  INDIRECT_LOADER_IDENTIFIERS,
  INDIRECT_LOADER_PROPERTIES,
  LOADER_BUILTIN_ALLOWANCES,
  LOADER_BUILTINS,
  NEXT_CONFIG_ALLOWED_KEYS,
  NEXT_CONFIG_FILE,
  NEXT_CONFIG_SIBLINGS,
  OBFUSCATED_SPECIFIER_PATTERN,
  organizationRuleFor,
  PACKAGE_SUBPATH_ESCAPE_PATTERN,
  packageNameOf,
  REGISTRY_URL_PREFIX,
  RULES,
  RUNTIME_ALLOWED_PACKAGES,
  RUNTIME_DIRECTORIES,
  RUNTIME_FILES,
  RUNTIME_REFUSED_IDENTIFIERS,
  TSCONFIG_PINNED_PATHS,
  TSCONFIG_REFUSED_KEYS,
  TSCONFIG_REFUSED_OPTIONS,
} from "./policy.mjs";

/**
 * @typedef {{ rule: string, file: string, specifier: string, message: string, line?: number }} Violation
 * @typedef {{ root: string, declared: ReadonlySet<string> }} Context
 * @typedef {{ specifier: string, line: number }} Located
 * @typedef {{
 *   specifiers: Located[],
 *   nonLiteral: Located[],
 *   loaders: Located[],
 *   computed: Located[],
 *   loaderImports: Located[],
 *   runtimeReferences: Located[],
 * }} ParsedSource
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
 * Text of a member name reached by dot or by a string-literal key; null for computed keys.
 * @param {ts.PropertyAccessExpression | ts.ElementAccessExpression} node
 * @returns {string | null}
 */
function memberName(node) {
  return ts.isPropertyAccessExpression(node) ? node.name.text : literalText(node.argumentExpression);
}

/**
 * Name of the object a member is read from, when it is a plain identifier or `import.meta`,
 * looking through parentheses and non-null assertions.
 * @param {ts.Expression} object
 * @returns {string | null}
 */
function objectName(object) {
  let inner = object;
  while (ts.isParenthesizedExpression(inner) || ts.isNonNullExpression(inner) || ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) {
    inner = inner.expression;
  }
  if (ts.isIdentifier(inner)) {
    return inner.text;
  }
  return ts.isMetaProperty(inner) ? "import.meta" : null;
}

/**
 * Builtin module name of a specifier, without the `node:` scheme, or null.
 * @param {string} specifier
 * @returns {string | null}
 */
function builtinNameOf(specifier) {
  const bare = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  return BUILTINS.has(bare) ? bare : null;
}

/**
 * Local names bound by an import declaration (default, namespace and named bindings).
 * @param {ts.ImportDeclaration} declaration
 * @returns {string[]}
 */
function importedBindingNames(declaration) {
  const clause = declaration.importClause;
  if (clause === undefined) {
    return [];
  }
  const names = clause.name === undefined ? [] : [clause.name.text];
  const bindings = clause.namedBindings;
  if (bindings !== undefined) {
    if (ts.isNamespaceImport(bindings)) {
      names.push(bindings.name.text);
    } else {
      names.push(...bindings.elements.map((element) => element.name.text));
    }
  }
  return names;
}

/**
 * Whether a file belongs to the runtime source set of a repository root.
 * @param {string} root absolute
 * @param {string} file absolute
 */
export function isRuntimeFile(root, file) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  return RUNTIME_FILES.includes(relative) || RUNTIME_DIRECTORIES.some((directory) => relative.startsWith(`${directory}/`));
}

/**
 * Parses source text and collects module specifiers, dynamic imports or requires whose argument
 * list is not exactly one string literal, indirect loaders, computed member accesses on refused
 * bindings, loader-builtin imports, and (for runtime source) every reference to a refused identifier.
 * @param {string} source
 * @param {string} fileName decides the script kind (.ts, .tsx, .mjs, ...)
 * @param {{ runtime?: boolean }} [options]
 * @returns {ParsedSource}
 */
export function parseSource(source, fileName, options = {}) {
  const runtime = options.runtime === true;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  /** @type {ParsedSource} */
  const parsed = { specifiers: [], nonLiteral: [], loaders: [], computed: [], loaderImports: [], runtimeReferences: [] };
  /** Local bindings that came from a loader builtin; computed access on them is refused. */
  const loaderBindings = new Set(COMPUTED_ACCESS_REFUSED_OBJECTS);
  /** @param {ts.Node} node */
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  /** @param {Located[]} bucket @param {string} specifier @param {ts.Node} node */
  const record = (bucket, specifier, node) => bucket.push({ specifier, line: lineOf(node) });
  /**
   * Static declarations only ever carry string literals (the grammar rejects anything else), so the
   * fallback text is unreachable; dynamic forms are classified in the call-expression branch.
   * @param {ts.Node} literal
   * @returns {string}
   */
  const staticText = (literal) => literalText(literal) ?? literal.getText(sourceFile);
  /** @param {string} specifier @param {ts.Node} node */
  const noteLoaderBuiltin = (specifier, node) => {
    const builtin = builtinNameOf(specifier);
    if (builtin !== null && LOADER_BUILTINS.includes(builtin)) {
      record(parsed.loaderImports, builtin, node);
    }
  };
  /** @param {ts.Node} literal */
  const staticSpecifier = (literal) => {
    const text = staticText(literal);
    record(parsed.specifiers, text, literal);
    noteLoaderBuiltin(text, literal);
  };

  for (const reference of [...sourceFile.referencedFiles, ...sourceFile.typeReferenceDirectives]) {
    parsed.specifiers.push({ specifier: reference.fileName, line: sourceFile.getLineAndCharacterOfPosition(reference.pos).line + 1 });
  }
  for (const dependency of sourceFile.amdDependencies) {
    parsed.specifiers.push({ specifier: dependency.path, line: 1 });
  }
  // First pass: bindings introduced by loader-builtin imports, so later accesses can be judged.
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const builtin = builtinNameOf(statement.moduleSpecifier.text);
      if (builtin !== null && LOADER_BUILTINS.includes(builtin)) {
        for (const name of importedBindingNames(statement)) {
          loaderBindings.add(name);
        }
      }
    }
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
      if (isDynamicImport || isRequire) {
        const [argument] = node.arguments;
        const literal = node.arguments.length === 1 && argument !== undefined ? literalText(argument) : null;
        if (literal === null) {
          record(parsed.nonLiteral, node.getText(sourceFile), node);
        } else {
          record(parsed.specifiers, literal, node);
          noteLoaderBuiltin(literal, node);
        }
        // The callee identifier is legitimate here; skip it and visit the arguments only.
        for (const argumentNode of node.arguments) {
          visit(argumentNode);
        }
        return;
      }
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const object = objectName(node.expression);
      const name = memberName(node);
      if (name === null) {
        const numeric = ts.isElementAccessExpression(node) && ts.isNumericLiteral(node.argumentExpression);
        const refusedObject = object !== null && (loaderBindings.has(object) || object === "import.meta");
        if (refusedObject || (runtime && !numeric)) {
          record(parsed.computed, node.getText(sourceFile), node);
        }
      } else if (object !== null && INDIRECT_LOADER_PROPERTIES.includes(`${object}.${name}`)) {
        record(parsed.loaders, `${object}.${name}`, node);
      } else if (INDIRECT_LOADER_IDENTIFIERS.includes(name) || name === "require") {
        record(parsed.loaders, name, node);
      }
      if (ts.isElementAccessExpression(node) && name !== null && runtime && RUNTIME_REFUSED_IDENTIFIERS.includes(name)) {
        record(parsed.runtimeReferences, name, node);
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      record(parsed.loaders, "new Function", node);
    } else if (ts.isIdentifier(node)) {
      if (INDIRECT_LOADER_IDENTIFIERS.includes(node.text) || node.text === "require") {
        record(parsed.loaders, node.text, node);
      }
      if (runtime && RUNTIME_REFUSED_IDENTIFIERS.includes(node.text)) {
        record(parsed.runtimeReferences, node.text, node);
      }
    } else if (ts.isMetaProperty(node) && runtime) {
      record(parsed.runtimeReferences, "import.meta", node);
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
  return parseSource(source, fileName).specifiers.map((entry) => entry.specifier);
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
  if (OBFUSCATED_SPECIFIER_PATTERN.test(specifier)) {
    return violation(RULES.escapesRepository, "Specifiers must not contain backslashes or percent-encoding.");
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
  if (specifier.startsWith("node:")) {
    return BUILTINS.has(specifier.slice("node:".length))
      ? null
      : violation(RULES.undeclaredDependency, "Only real Node.js builtins may use the node: scheme.");
  }
  if (BUILTINS.has(specifier)) {
    return null;
  }
  if (PACKAGE_SUBPATH_ESCAPE_PATTERN.test(specifier)) {
    return violation(RULES.escapesRepository, "Package subpaths must not contain dot segments.");
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
 * Checks a specifier against the runtime allowlist; only called for runtime source.
 * @param {string} specifier
 * @returns {boolean}
 */
export function isRuntimeAllowedSpecifier(specifier) {
  if (specifier.startsWith("@/")) {
    return true;
  }
  return RUNTIME_ALLOWED_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

/**
 * Checks every import and refused construct of one source text.
 * @param {string} source
 * @param {string} file absolute path the source is attributed to
 * @param {Context} context
 * @returns {Violation[]}
 */
export function checkSource(source, file, context) {
  /** @type {Violation[]} */
  const violations = [];
  const relativeFile = attributed(context.root, file);
  const runtime = isRuntimeFile(context.root, file);
  const parsed = parseSource(source, file, { runtime });
  /** @param {string} rule @param {Located} located @param {string} message */
  const add = (rule, located, message) =>
    violations.push({ rule, file: relativeFile, specifier: located.specifier, message, line: located.line });

  for (const located of parsed.specifiers) {
    const found = checkSpecifier(located.specifier, file, context);
    if (found) {
      violations.push({ ...found, line: located.line });
    } else if (runtime && !isRuntimeAllowedSpecifier(located.specifier)) {
      add(RULES.runtimeImport, located, "Runtime source imports only next, react, react-dom and repository files through @/.");
    }
  }
  for (const located of parsed.nonLiteral) {
    add(RULES.nonLiteralSpecifier, located, "Dynamic import and require arguments must be exactly one string literal.");
  }
  for (const located of parsed.loaders) {
    add(RULES.indirectLoader, located, "Indirect module loaders, code evaluation and require outside a direct call are refused.");
  }
  for (const located of parsed.computed) {
    add(RULES.computedAccess, located, "Computed member access is refused; members are named with identifiers or string literals.");
  }
  const posixFile = relativeFile.split(path.sep).join("/");
  const allowedBuiltins = /** @type {ReadonlyArray<string>} */ (
    Object.prototype.hasOwnProperty.call(LOADER_BUILTIN_ALLOWANCES, posixFile)
      ? LOADER_BUILTIN_ALLOWANCES[/** @type {keyof typeof LOADER_BUILTIN_ALLOWANCES} */ (posixFile)]
      : []
  );
  for (const located of parsed.loaderImports) {
    if (!allowedBuiltins.includes(located.specifier)) {
      add(RULES.indirectLoader, located, "Code-loading and process builtins are refused outside the files allowed in policy.mjs.");
    }
  }
  for (const located of parsed.runtimeReferences) {
    add(RULES.runtimeReference, located, "Runtime source references no process, global, module-system, network or timer identifier.");
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
  const sourceFile = ts.createSourceFile(NEXT_CONFIG_FILE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  /** @param {ts.Node} node @param {string} specifier @param {string} message */
  const add = (node, specifier, message) =>
    violations.push({
      rule: RULES.resolutionSurface,
      file: NEXT_CONFIG_FILE,
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
 * Checks that exactly one Next.js configuration file exists and that it is the checked one; Next
 * loads `next.config.js`/`.mjs` before `.ts`, so any sibling would replace the pinned configuration.
 * @param {string} root absolute
 * @returns {Violation[]}
 */
export function checkNextConfigFiles(root) {
  /** @type {Violation[]} */
  const violations = [];
  if (!existsSync(path.join(root, NEXT_CONFIG_FILE))) {
    violations.push({
      rule: RULES.resolutionSurface,
      file: NEXT_CONFIG_FILE,
      specifier: NEXT_CONFIG_FILE,
      message: "The pinned next.config.ts is required.",
    });
  }
  for (const sibling of NEXT_CONFIG_SIBLINGS) {
    if (existsSync(path.join(root, sibling))) {
      violations.push({
        rule: RULES.resolutionSurface,
        file: sibling,
        specifier: sibling,
        message: "Only next.config.ts may exist; Next.js would load this file instead.",
      });
    }
  }
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
  const nextConfig = path.join(absoluteRoot, NEXT_CONFIG_FILE);
  const violations = [
    ...checkManifest(manifest),
    ...checkLockfile(lockfile, manifest),
    ...checkTsconfig(readTsconfig(path.join(absoluteRoot, "tsconfig.json"))),
    ...checkNextConfigFiles(absoluteRoot),
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
