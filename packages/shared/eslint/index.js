import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // 本地垃圾/工作区目录不入 lint：tmp/ 是第三方实验代码，.worktrees/ 是其他分支的
  // 工作树副本（均已被 .gitignore 排除，fresh clone 不存在；仓库自身源码必须全绿）。
  { ignores: ["**/dist/**", "**/coverage/**", "node_modules/**", "**/tmp/**", "**/.worktrees/**"] },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: globals.node },
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  prettier,
);
