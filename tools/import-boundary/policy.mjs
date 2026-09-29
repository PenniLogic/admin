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
  undeclaredDependency: "undeclared-dependency",
  nonRegistryDependency: "non-registry-or-inexact-dependency",
  workspaceOrBundle: "workspace-or-bundled-dependency",
  lockfile: "lockfile-provenance",
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

/** Absolute filesystem paths, URLs and direct node_modules paths are never valid specifiers. */
export const ABSOLUTE_OR_REMOTE_PATTERN = /^(?:\/|\\|[A-Za-z]:[\\/]|file:|https?:|data:|node_modules\/)/i;

/** Dependency versions must be exact registry releases; ranges, links, files and URLs are refused. */
export const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Every locked package must come from the public registry with an integrity hash. */
export const REGISTRY_URL_PREFIX = "https://registry.npmjs.org/";

/**
 * ESLint `no-restricted-imports` patterns mirroring the name-based rules, so a planted import fails
 * `npm run lint` as well as `npm test`. Repository-escape and provenance rules need path resolution
 * and manifest access, which the scanner provides.
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
