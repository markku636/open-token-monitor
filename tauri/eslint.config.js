import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// 最小化 ESLint 設定：專注守住 React Hooks 規則。
// rules-of-hooks 設為 error，「在條件式 / 提前 return 之前呼叫 hook」這類錯誤在 build 時就攔下。
export default [
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
