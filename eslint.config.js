import js from "@eslint/js";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import ts from "typescript-eslint";

export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ["**/*.svelte"],
    languageOptions: {
      parserOptions: {
        parser: ts.parser,
      },
    },
  },
  {
    files: ["vite.config.ts", "svelte.config.js", "eslint.config.js"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    ignores: ["dist/**", "src-tauri/**", "node_modules/**", ".svelte-kit/**"],
  },
);
