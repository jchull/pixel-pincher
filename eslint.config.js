import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [".output/**", "dist/**", ".wxt/**", "node_modules/**"],
  },
];
