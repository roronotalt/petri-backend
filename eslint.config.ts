import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import jsdoc from "eslint-plugin-jsdoc";

const dir_path = dirname(fileURLToPath(import.meta.url));

export default defineConfig([
  js.configs.recommended,
  tseslint.configs.recommended,
  jsdoc.configs["flat/recommended-typescript"],
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    plugins: { jsdoc },
    rules: {
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: "function",
          format: ["camelCase"],
        },
        {
          selector: "variable",
          format: ["snake_case"],
        },
        {
          selector: "class",
          format: ["PascalCase"],
        },
        {
          selector: "interface",
          format: ["PascalCase"],
        },
      ],
      "no-unused-vars": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-floating-promises": "error",
      // jsdoc
      "jsdoc/require-jsdoc": [
        "warn",
        {
          contexts: [
            "FunctionDeclaration",
            "FunctionExpression",
            "ArrowFunctionExpression",
            "MethodDefinition",
            "ClassDeclaration",
            "TSInterfaceDeclaration",
            "TSTypeAliasDeclaration",
            "TSEnumDeclaration",
            "ExportNamedDeclaration",
          ],
        },
      ],
      "jsdoc/check-values": [
        "error",
        {
          allowedLicenses: ["ISC"],
        },
      ],
      "jsdoc/check-tag-names": [
        "warn",
        {
          definedTags: ["remarks"],
        },
      ],
    },
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: dir_path,
      },
    },
  },
]);
