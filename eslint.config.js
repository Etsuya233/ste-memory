import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

const memoryEntryRestriction = {
  group: ["**/features/memory/**", "!**/features/memory/index.ts"],
  message: "Memory 只能通过 features/memory/index.ts 使用。",
};

const outerLayerRestrictions = [
  { group: ["**/infrastructure/**"], message: "功能层不依赖具体基础设施。" },
  { group: ["**/ui/**"], message: "功能层不依赖 UI。" },
];

export default tseslint.config(
  // 本地垃圾/工作区目录不入 lint：tmp/ 是第三方实验代码，.worktrees/ 是其他分支的
  // 工作树副本（均已被 .gitignore 排除，fresh clone 不存在；仓库自身源码必须全绿）。
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "node_modules/**",
      "**/tmp/**",
      "**/.worktrees/**",
      ".scratch/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: globals.node },
  },
  // 浏览器验收脚本（Playwright page.evaluate）：浏览器全局 + ST 全局
  {
    files: ["docs/playwright-st-extension/**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.browser,
        $: "readonly",
        jQuery: "readonly",
        SillyTavern: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  // 入口与分层约束（与 tests/architecture/memory-boundaries.test.ts 互为兜底）：
  // Memory 只能通过 features/memory/index.ts 使用；功能层不依赖具体基础设施与 UI。
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/features/memory/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [memoryEntryRestriction],
        },
      ],
    },
  },
  {
    files: ["src/features/**/*.{ts,tsx}"],
    ignores: ["src/features/memory/**", "**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          // Flat config 的同名规则会覆盖，必须同时保留两类限制。
          patterns: [
            memoryEntryRestriction,
            {
              group: ["../memory/**", "!../memory/index.ts"],
              message: "Memory 只能通过 features/memory/index.ts 使用。",
            },
            ...outerLayerRestrictions,
          ],
        },
      ],
    },
  },
  {
    files: ["src/features/memory/**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "no-restricted-imports": ["error", { patterns: outerLayerRestrictions }],
    },
  },
  {
    files: ["src/features/memory/domain/**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...outerLayerRestrictions,
            { regex: "^(?!\\.{1,2}/)", message: "Domain 只依赖自身领域文件。" },
          ],
        },
      ],
    },
  },
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
