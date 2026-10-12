import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.wrangler/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "tests/realworld/vendor/**",
      ".superpowers/**",
      // 평가 케이스 픽스처는 일부러 규칙을 어기는 코드다. eval 체크가 따로 lint한다.
      "factory/evals/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    // React Compiler 규칙(set-state-in-effect 등)은 쓰지 않는다. 고전 규칙 2개만 켠다.
    rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "error" },
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["scripts/**/*.mjs", "**/*.config.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["packages/factory/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
);
