import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs"
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["warn", { allowEmptyCatch: true }]
    }
  },
  {
    files: ["main.js", "preload.js", "downloader.js", "proxy.js", "test/**/*.js"],
    languageOptions: {
      globals: globals.node
    }
  },
  {
    files: ["renderer.js"],
    languageOptions: {
      globals: globals.browser
    }
  },
  {
    files: ["extension/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
        chrome: "readonly",
        WebSocket: "readonly"
      }
    }
  }
];
