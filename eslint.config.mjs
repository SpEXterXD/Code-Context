import eslint from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";
import boundaries from "eslint-plugin-boundaries";

/**
 * Layered architecture (docs/ARCHITECTURE.md), machine-enforced.
 *
 * Dependency direction (lowest → highest):
 *   shared → domain → git → workspace → parser → analysis → security →
 *   index → clipboard → retrieval → context → application → extension
 *
 * Each element may import only the elements explicitly listed for it (plus
 * lower ones transitively expressed in those lists). A new cross-layer
 * import that is not in the list fails lint — changes to the layering are
 * now deliberate config edits, not silent accidents. Test files are exempt
 * (they exercise several layers by design).
 */
const ALLOWED_IMPORTS = {
  shared: [],
  domain: ["shared"],
  git: [],
  workspace: ["domain", "shared"],
  parser: ["domain", "shared"],
  analysis: ["parser", "workspace", "domain", "shared"],
  security: ["domain", "shared"],
  index: ["domain", "shared"],
  clipboard: ["shared"],
  retrieval: ["git", "domain", "shared"],
  context: ["retrieval", "analysis", "security", "domain", "shared"],
  application: [
    "context",
    "retrieval",
    "index",
    "security",
    "analysis",
    "parser",
    "workspace",
    "git",
    "domain",
    "shared",
  ],
  extension: [
    "application",
    "context",
    "retrieval",
    "security",
    "analysis",
    "parser",
    "workspace",
    "git",
    "domain",
    "shared",
    "clipboard",
  ],
};

const layerMessage =
  "{{file.type}} is not allowed to import {{dependency.type}} (layered architecture; see docs/ARCHITECTURE.md)";

export default [
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": eslint,
    },
    rules: {
      ...eslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-console": "off",
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    // Layer boundaries: production code only. Tests cross layers by design.
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    plugins: {
      boundaries,
    },
    settings: {
      "boundaries/elements": [
        { type: "shared", pattern: "src/shared/**" },
        { type: "domain", pattern: "src/domain/**" },
        { type: "git", pattern: "src/git/**" },
        { type: "workspace", pattern: "src/workspace/**" },
        { type: "parser", pattern: "src/parser/**" },
        { type: "analysis", pattern: "src/analysis/**" },
        { type: "security", pattern: "src/security/**" },
        { type: "index", pattern: "src/index/**" },
        { type: "clipboard", pattern: "src/clipboard/**" },
        { type: "retrieval", pattern: "src/retrieval/**" },
        { type: "context", pattern: "src/context/**" },
        { type: "application", pattern: "src/application/**" },
        { type: "extension", pattern: "src/extension/**" },
      ],
    },
    rules: {
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          message: layerMessage,
          policies: Object.entries(ALLOWED_IMPORTS).map(([from, allow]) => ({
            from: { element: { type: from } },
            allow: allow.map((to) => ({ to: { element: { type: to } } })),
          })),
        },
      ],
    },
  },
  {
    // vscode is an external module, not a layer element: enforce its
    // confinement with core no-restricted-imports (extension exempt).
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts", "src/extension/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["vscode"],
              message: "Only src/extension may import vscode (layered architecture).",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "out-e2e/**", "demo-project/**", "test-fixtures/**"],
  },
];
