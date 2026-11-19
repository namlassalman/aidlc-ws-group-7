// ESLint flat config: typescript-eslint recommended rules for the whole repository.
// Feature Units do not change this file (team Code Style).
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "cdk.out/**",
      "coverage/**",
      "dist/**",
      "aidlc/**",
      ".claude/**",
      "tools/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
