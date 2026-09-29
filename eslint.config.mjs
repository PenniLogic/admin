// @ts-check
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

import {
  LOADER_BUILTIN_ALLOWANCES,
  LOADER_BUILTINS,
  RESTRICTED_IMPORT_PATHS,
  RESTRICTED_IMPORT_PATTERNS,
  RUNTIME_DIRECTORIES,
  RUNTIME_FILES,
  RUNTIME_RESTRICTED_GLOBALS,
  RUNTIME_RESTRICTED_IMPORT_PATTERNS,
} from "./tools/import-boundary/policy.mjs";

const runtimeFiles = [...RUNTIME_FILES, ...RUNTIME_DIRECTORIES.map((directory) => `${directory}/**`)];

/**
 * `no-restricted-imports` paths refusing every loader builtin except the ones a file is allowed.
 * Mirrors the scanner's per-file allowances exactly.
 * @param {ReadonlyArray<string>} allowed
 */
const loaderBuiltinPaths = (allowed) =>
  LOADER_BUILTINS.filter((name) => name !== "module" && !allowed.includes(name))
    .flatMap((name) => [name, `node:${name}`])
    .map((name) => ({ name, message: "Code-loading and process builtins are refused outside the files allowed in policy.mjs." }));

/** The bindings whose computed access is refused; TypeScript wrappers around them are looked through. */
const refusedObjects = "/^(process|globalThis|module|require|window|self)$/";
const tsWrapper = ":matches(TSAsExpression, TSSatisfiesExpression, TSNonNullExpression, TSTypeAssertion)";

const sharedRestrictedSyntax = [
  {
    selector: "MemberExpression[object.type='MetaProperty'][property.name='resolve']",
    message: "import.meta.resolve assembles specifiers at run time and is refused.",
  },
  {
    selector: `MemberExpression[computed=true][object.name=${refusedObjects}]`,
    message: "Computed member access on process, globalThis, module, require, window or self is refused.",
  },
  {
    // Best-effort mirror of the scanner's look-through: up to three TypeScript wrappers deep.
    selector: [
      `MemberExpression[computed=true] > ${tsWrapper}.object > Identifier.expression[name=${refusedObjects}]`,
      `MemberExpression[computed=true] > ${tsWrapper}.object > ${tsWrapper}.expression > Identifier.expression[name=${refusedObjects}]`,
      `MemberExpression[computed=true] > ${tsWrapper}.object > ${tsWrapper}.expression > ${tsWrapper}.expression > Identifier.expression[name=${refusedObjects}]`,
    ].join(", "),
    message: "Computed member access on a TypeScript-wrapped process, globalThis, module, require, window or self is refused.",
  },
  {
    selector: "MemberExpression[computed=true][object.type='MetaProperty']",
    message: "Computed member access on import.meta is refused.",
  },
  {
    selector: "MemberExpression[property.name='constructor'] > CallExpression, CallExpression > MemberExpression.callee[property.name='constructor']",
    message: "Calling a constructor member can reach Function; it is refused.",
  },
  {
    selector: "Identifier[name='require']:not(CallExpression > Identifier.callee)",
    message: "require may only appear as the callee of a direct call.",
  },
  {
    selector: "Identifier[name='Reflect']",
    message: "Reflect reaches members without naming them and is refused.",
  },
];

export default defineConfig([
  globalIgnores([".next/**", "coverage/**", "node_modules/**", "next-env.d.ts"]),
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  nextPlugin.configs["core-web-vitals"],
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Script files are linted without type information; the scanner still parses all of them.
    files: ["**/*.{js,jsx,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    rules: {
      // Mirrors tools/import-boundary/policy.mjs for static imports so a planted customer import
      // fails lint too; the scanner (npm run check:imports) is authoritative for everything else.
      "no-restricted-imports": [
        "error",
        { patterns: [...RESTRICTED_IMPORT_PATTERNS], paths: [...RESTRICTED_IMPORT_PATHS, ...loaderBuiltinPaths([])] },
      ],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-restricted-properties": [
        "error",
        { object: "require", property: "resolve", message: "Specifiers are never resolved at run time." },
        { object: "process", property: "getBuiltinModule", message: "Builtins are imported statically, never fetched at run time." },
        { object: "process", property: "binding", message: "Native bindings are never reached from this repository." },
        { object: "process", property: "dlopen", message: "Native bindings are never reached from this repository." },
        { object: "process", property: "mainModule", message: "The module system is never reached through process." },
      ],
      "no-restricted-syntax": ["error", ...sharedRestrictedSyntax],
      "no-console": ["error", { allow: ["error", "log"] }],
    },
  },
  ...Object.entries(LOADER_BUILTIN_ALLOWANCES).map(([file, allowed]) => ({
    // Each allowance file may import exactly its listed builtins; everything else stays refused.
    files: [file],
    rules: {
      "no-restricted-imports": /** @type {["error", { patterns: unknown[], paths: unknown[] }]} */ ([
        "error",
        { patterns: [...RESTRICTED_IMPORT_PATTERNS], paths: [...RESTRICTED_IMPORT_PATHS, ...loaderBuiltinPaths(allowed)] },
      ]),
    },
  })),
  {
    // Runtime source: exact type-only import allowlist and no process/global/module/network/timer
    // identifier, no `this`, no computed member or key.
    files: runtimeFiles,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [...RESTRICTED_IMPORT_PATTERNS, ...RUNTIME_RESTRICTED_IMPORT_PATTERNS],
          paths: [...RESTRICTED_IMPORT_PATHS, ...loaderBuiltinPaths([])],
        },
      ],
      "no-restricted-globals": ["error", ...RUNTIME_RESTRICTED_GLOBALS],
      "no-restricted-syntax": [
        "error",
        ...sharedRestrictedSyntax,
        {
          selector: "MemberExpression[computed=true]:not([property.type='Literal'])",
          message: "Runtime source uses no computed member access.",
        },
        {
          selector: ":matches(Property, PropertyDefinition, MethodDefinition, TSPropertySignature)[computed=true]:not([key.type='Literal'])",
          message: "Runtime source uses no computed property keys.",
        },
        {
          selector: "MetaProperty",
          message: "Runtime source does not reference import.meta or new.target.",
        },
        {
          selector: "ThisExpression",
          message: "Runtime source does not reference this.",
        },
        {
          // Dynamic import() carries a runtime value by definition, so no specifier is acceptable.
          selector: "ImportExpression",
          message: "Runtime source uses no dynamic import(); every import is static and type-only or a runtime repository file.",
        },
        {
          selector: "Identifier[name='require']",
          message: "Runtime source never references require.",
        },
      ],
    },
  },
]);
