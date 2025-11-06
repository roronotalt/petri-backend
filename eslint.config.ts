import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

export default defineConfig([
   tseslint.configs.recommended,
   {
      files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
      plugins: { js },
      extends: ["js/recommended"],
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
         "no-unused-vars": "off",
         "@typescript-eslint/no-unused-vars": "warn",
         "@typescript-eslint/no-explicit-any": "warn",
         "@typescript-eslint/no-floating-promises": "error",
      },
      languageOptions: {
         globals: {
            ...globals.node,
         },
         parserOptions: {
            projectService: true,
            tsconfigRootDir: import.meta.dirname,
         },
      },
   },
]);
