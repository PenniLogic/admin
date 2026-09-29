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
 * Identifiers that load or evaluate code outside the static import graph. Their presence anywhere
 * in scanned source is refused, so a specifier can never be assembled at run time.
 */
export const INDIRECT_LOADER_IDENTIFIERS = Object.freeze(["createRequire", "eval", "Function"]);

/** Property accesses that resolve specifiers at run time. */
export const INDIRECT_LOADER_PROPERTIES = Object.freeze(["require.resolve", "import.meta.resolve"]);

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
]);

/** ESLint `no-restricted-imports` paths mirroring the indirect-loader rule for the module builtin. */
export const RESTRICTED_IMPORT_PATHS = Object.freeze(
  ["node:module", "module"].map((name) => ({
    name,
    importNames: ["createRequire"],
    message: "createRequire assembles specifiers at run time and is refused by the admin import boundary.",
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
