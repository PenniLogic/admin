// @ts-check
/**
 * Import-boundary policy of the administrative console.
 *
 * The console is a separate service with a separate authorization domain (ADR-014). Source in this
 * repository may import only Node.js builtins, files inside this repository, and packages that are
 * declared in package.json and resolved from the public npm registry. Every PenniLogic-scoped or
 * PenniLogic-prefixed package is refused until the administrative API contract is published and
 * listed in ALLOWED_ORGANIZATION_PACKAGES by a reviewed change; the customer web application and
 * any shared client bundle are never eligible. The rules are structural: this repository does not
 * record the customer session cookie name or any customer hostname.
 */

/** Violation rule identifiers shared by the scanner, the tests and the ESLint mirror. */
export const RULES = Object.freeze({
  customerCode: "customer-web-or-shared-client",
  organizationPackage: "organization-package-not-allowed",
  escapesRepository: "escapes-repository",
  absoluteOrRemote: "absolute-or-remote-specifier",
  nonLiteralSpecifier: "non-literal-dynamic-specifier",
  indirectLoader: "indirect-module-loader",
  computedAccess: "computed-member-access",
  runtimeImport: "runtime-import-not-allowed",
  runtimeReference: "runtime-reference-not-allowed",
  undeclaredDependency: "undeclared-dependency",
  nonRegistryDependency: "non-registry-or-inexact-dependency",
  workspaceOrBundle: "workspace-or-bundled-dependency",
  lockfile: "lockfile-provenance",
  resolutionSurface: "resolution-surface",
});

/**
 * Organization packages this repository is allowed to consume. Empty by design: the only sanctioned
 * cross-repository artifact is the administrative API contract, which does not exist yet. The
 * customer API contract and customer web code stay excluded even after that list is populated.
 * @type {ReadonlyArray<string>}
 */
export const ALLOWED_ORGANIZATION_PACKAGES = Object.freeze([]);

/** Specifier fragments that name customer web code or a shared client bundle outright. */
export const CUSTOMER_CODE_PATTERN =
  /(?:^|\/)(?:customer-web|customer-client|customer-app|shared-client|web-client|client-bundle)(?:\/|$)/i;

/** Every package in the organization scope or with the organization prefix. */
export const ORGANIZATION_PACKAGE_PATTERN = /^(?:@pennilogic\/|pennilogic-)/i;

/**
 * Absolute filesystem paths, URLs, direct node_modules paths and package subpath imports (`#name`,
 * which the manifest could map anywhere) are never valid specifiers.
 */
export const ABSOLUTE_OR_REMOTE_PATTERN = /^(?:\/|\\|[A-Za-z]:[\\/]|file:|https?:|data:|node_modules\/|#)/i;

/**
 * A bare package specifier whose subpath contains a dot segment, a backslash or percent-encoding.
 * Packages without an `exports` map resolve such subpaths on the filesystem, so `next/../../x`
 * leaves the package and the repository.
 */
export const PACKAGE_SUBPATH_ESCAPE_PATTERN = /^(?:@[^/]+\/)?[^./\\%][^/\\%]*\/(?:.*\/)?(?:\.\.?(?:\/|$)|.*[\\%])/;

/** Any specifier that carries a backslash or percent-encoding, in any position. */
export const OBFUSCATED_SPECIFIER_PATTERN = /[\\%]/;

/**
 * Identifiers that load or evaluate code outside the static import graph. Any reference anywhere in
 * scanned source is refused: as an identifier, a property name or a string-literal element key.
 */
export const INDIRECT_LOADER_IDENTIFIERS = Object.freeze([
  "createRequire",
  "eval",
  "Function",
  "constructor",
  "getBuiltinModule",
  "binding",
  "dlopen",
  "mainModule",
  "_load",
  "runInThisContext",
  "runInNewContext",
  "runInContext",
  "compileFunction",
]);

/** Property accesses that resolve specifiers at run time. */
export const INDIRECT_LOADER_PROPERTIES = Object.freeze(["require.resolve", "import.meta.resolve"]);

/**
 * Bindings whose members must never be reached through a computed key: a non-literal element access
 * on any of them (`process["getBuiltin" + "Module"]`) could name a loader the identifier rule cannot see.
 * Namespace and default bindings imported from the loader builtins below join this set per file.
 */
export const COMPUTED_ACCESS_REFUSED_OBJECTS = Object.freeze(["process", "globalThis", "module", "require", "window", "self"]);

/**
 * Builtins that load or evaluate code. Importing them is refused everywhere except the listed
 * files, each of which needs exactly the named module and is itself scanned.
 */
export const LOADER_BUILTINS = Object.freeze(["module", "vm", "worker_threads", "child_process", "process"]);
export const LOADER_BUILTIN_ALLOWANCES = Object.freeze({
  // builtinModules only; createRequire and the default export stay refused by ESLint everywhere.
  "tools/import-boundary/scan.mjs": Object.freeze(["module"]),
  "tools/next-cli.mjs": Object.freeze(["child_process"]),
  "tests/smoke/server.test.ts": Object.freeze(["child_process"]),
  "tests/unit/import-boundary.test.ts": Object.freeze(["child_process"]),
});

/**
 * Positive allowlist for runtime source (`proxy.ts`, `app/**`, `src/**`, `next.config.ts`): the
 * deny-only runtime imports only these packages (any subpath) and repository files through `@/`.
 */
export const RUNTIME_ALLOWED_PACKAGES = Object.freeze(["next", "react", "react-dom"]);

/**
 * Identifiers runtime source must not reference at all. The deny-only runtime needs no process,
 * global, module-system or builtin access; this is structural, not a blocklist of loader names.
 */
export const RUNTIME_REFUSED_IDENTIFIERS = Object.freeze([
  "process",
  "globalThis",
  "global",
  "window",
  "self",
  "module",
  "exports",
  "require",
  "eval",
  "Function",
  "Reflect",
  "Proxy",
  "WebAssembly",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "Worker",
  "SharedWorker",
  "importScripts",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "structuredClone",
  "AsyncFunction",
  "GeneratorFunction",
  "AsyncGeneratorFunction",
]);

/** Directories and files that make up the runtime source set. */
export const RUNTIME_DIRECTORIES = Object.freeze(["app", "src"]);
export const RUNTIME_FILES = Object.freeze(["proxy.ts", "next.config.ts"]);

/** The one configuration file Next.js may find; any sibling would be loaded before it. */
export const NEXT_CONFIG_FILE = "next.config.ts";
export const NEXT_CONFIG_SIBLINGS = Object.freeze([
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.mts",
  "next.config.cts",
  "next.config.json",
]);

/**
 * The only path mapping the compiler, the bundler and the test runner may share. Anything else
 * could remap an accepted specifier to a location outside this repository.
 */
export const TSCONFIG_PINNED_PATHS = Object.freeze({ "@/*": Object.freeze(["./*"]) });

/** Compiler options that relocate module resolution and are therefore refused. */
export const TSCONFIG_REFUSED_OPTIONS = Object.freeze(["baseUrl", "rootDirs", "rootDir", "typeRoots", "types"]);

/** Top-level tsconfig keys that pull configuration or files from elsewhere. */
export const TSCONFIG_REFUSED_KEYS = Object.freeze(["extends", "references", "files"]);

/**
 * The complete set of keys next.config.ts may contain. Every resolution or transpilation surface
 * (`turbopack`, `webpack`, `transpilePackages`, `experimental`, `outputFileTracingRoot`,
 * `serverExternalPackages`, `rewrites`, `redirects`, `basePath`, `assetPrefix`, ...) is absent by
 * construction and must be added here by a reviewed change.
 */
export const NEXT_CONFIG_ALLOWED_KEYS = Object.freeze([
  "reactStrictMode",
  "poweredByHeader",
  "skipTrailingSlashRedirect",
  "skipProxyUrlNormalize",
]);

/** Dependency versions must be exact registry releases; ranges, links, files and URLs are refused. */
export const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Every locked package must come from the public registry with an integrity hash. */
export const REGISTRY_URL_PREFIX = "https://registry.npmjs.org/";

/**
 * ESLint `no-restricted-imports` patterns mirroring the name-based rules for static imports, so a
 * planted import fails `npm run lint` as well as `npm test`. Dynamic imports, repository escapes,
 * indirect loaders, configuration surfaces and provenance need the scanner, which is authoritative.
 */
export const RESTRICTED_IMPORT_PATTERNS = Object.freeze([
  {
    regex: CUSTOMER_CODE_PATTERN.source,
    caseSensitive: false,
    message: "Customer web code and shared client bundles must never be imported by the admin console.",
  },
  {
    regex: ORGANIZATION_PACKAGE_PATTERN.source,
    caseSensitive: false,
    message:
      "PenniLogic packages are refused until the administrative API contract is published and allowed in tools/import-boundary/policy.mjs.",
  },
  {
    regex: ABSOLUTE_OR_REMOTE_PATTERN.source,
    caseSensitive: false,
    message: "Import only repository files, Node.js builtins and declared registry packages.",
  },
  {
    regex: PACKAGE_SUBPATH_ESCAPE_PATTERN.source,
    caseSensitive: false,
    message: "Package subpaths must not contain dot segments, backslashes or percent-encoding.",
  },
  {
    regex: OBFUSCATED_SPECIFIER_PATTERN.source,
    caseSensitive: false,
    message: "Specifiers must not contain backslashes or percent-encoding.",
  },
]);

/**
 * ESLint `no-restricted-imports` patterns for runtime source only: everything except the allowed
 * runtime packages (any subpath) and the repository alias is refused.
 */
export const RUNTIME_RESTRICTED_IMPORT_PATTERNS = Object.freeze([
  {
    regex: `^(?!(?:${RUNTIME_ALLOWED_PACKAGES.map((name) => name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})(?:/|$)|@/)`,
    caseSensitive: true,
    message: "Runtime source imports only next, react, react-dom and repository files through @/.",
  },
]);

/** ESLint `no-restricted-imports` paths mirroring the indirect-loader rule for the module builtin. */
export const RESTRICTED_IMPORT_PATHS = Object.freeze(
  ["node:module", "module"].map((name) => ({
    name,
    importNames: ["createRequire", "default"],
    message: "The module builtin assembles specifiers at run time and is refused by the admin import boundary.",
  })),
);

/** ESLint `no-restricted-imports` paths for every file without an allowance in LOADER_BUILTIN_ALLOWANCES. */
export const RESTRICTED_LOADER_BUILTIN_PATHS = Object.freeze(
  LOADER_BUILTINS.filter((name) => name !== "module")
    .flatMap((name) => [name, `node:${name}`])
    .map((name) => ({ name, message: "Code-loading and process builtins are refused outside the files allowed in policy.mjs." })),
);

/** ESLint `no-restricted-globals` entries mirroring the runtime-reference rule. */
export const RUNTIME_RESTRICTED_GLOBALS = Object.freeze(
  RUNTIME_REFUSED_IDENTIFIERS.map((name) => ({
    name,
    message: "Runtime source references no process, global, module-system, network or timer identifier.",
  })),
);

/**
 * Returns the package name of a bare specifier (`@scope/name/sub` -> `@scope/name`).
 * @param {string} specifier
 */
export function packageNameOf(specifier) {
  const depth = specifier.startsWith("@") ? 2 : 1;
  return specifier.split("/").slice(0, depth).join("/");
}

/**
 * Classifies a package name against the organization rules.
 * @param {string} name
 * @returns {string | null} rule identifier, or null when the name is acceptable
 */
export function organizationRuleFor(name) {
  if (CUSTOMER_CODE_PATTERN.test(name)) {
    return RULES.customerCode;
  }
  if (ORGANIZATION_PACKAGE_PATTERN.test(name) && !ALLOWED_ORGANIZATION_PACKAGES.includes(name)) {
    return RULES.organizationPackage;
  }
  return null;
}
