// @ts-check
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

import {
  LOADER_BUILTIN_ALLOWANCES,
  RESTRICTED_IMPORT_PATHS,
  RESTRICTED_IMPORT_PATTERNS,
  RESTRICTED_LOADER_BUILTIN_PATHS,
  RUNTIME_DIRECTORIES,
  RUNTIME_FILES,
  RUNTIME_RESTRICTED_GLOBALS,
  RUNTIME_RESTRICTED_IMPORT_PATTERNS,
} from "./tools/import-boundary/policy.mjs";

const runtimeFiles = [...RUNTIME_FILES, ...RUNTIME_DIRECTORIES.map((directory) => `${directory}/**`)];
const loaderAllowedFiles = Object.keys(LOADER_BUILTIN_ALLOWANCES);

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
        { patterns: [...RESTRICTED_IMPORT_PATTERNS], paths: [...RESTRICTED_IMPORT_PATHS] },
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
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.type='MetaProperty'][property.name='resolve']",
          message: "import.meta.resolve assembles specifiers at run time and is refused.",
        },
        {
          selector: "MemberExpression[computed=true][object.name=/^(process|globalThis|module|require|window|self)$/]",
          message: "Computed member access on process, globalThis, module, require, window or self is refused.",
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
      ],
      "no-console": ["error", { allow: ["error", "log"] }],
    },
  },
  {
    files: ["**/*"],
    ignores: loaderAllowedFiles,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [...RESTRICTED_IMPORT_PATTERNS],
          paths: [...RESTRICTED_IMPORT_PATHS, ...RESTRICTED_LOADER_BUILTIN_PATHS],
        },
      ],
    },
  },
  {
    // Runtime source: positive import allowlist and no process/global/module/network/timer identifier.
    files: runtimeFiles,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [...RESTRICTED_IMPORT_PATTERNS, ...RUNTIME_RESTRICTED_IMPORT_PATTERNS],
          paths: [...RESTRICTED_IMPORT_PATHS, ...RESTRICTED_LOADER_BUILTIN_PATHS],
        },
      ],
      "no-restricted-globals": ["error", ...RUNTIME_RESTRICTED_GLOBALS],
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[computed=true]:not([property.type='Literal'])",
          message: "Runtime source uses no computed member access.",
        },
        {
          selector: "MetaProperty",
          message: "Runtime source does not reference import.meta or new.target.",
        },
        {
          selector: "Identifier[name='require']",
          message: "Runtime source never references require.",
        },
      ],
    },
  },
]);
