// @ts-check
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

import { RESTRICTED_IMPORT_PATHS, RESTRICTED_IMPORT_PATTERNS } from "./tools/import-boundary/policy.mjs";

export default defineConfig([
  globalIgnores([".next/**", "coverage/**", "node_modules/**", "next-env.d.ts"]),
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  nextPlugin.configs["core-web-vitals"],
  {
    files: ["**/*.{ts,tsx,mts}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.mjs"],
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
      "no-new-func": "error",
      "no-restricted-properties": [
        "error",
        { object: "require", property: "resolve", message: "Specifiers are never resolved at run time." },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.type='MetaProperty'][property.name='resolve']",
          message: "import.meta.resolve assembles specifiers at run time and is refused.",
        },
      ],
      "no-console": ["error", { allow: ["error", "log"] }],
    },
  },
]);
