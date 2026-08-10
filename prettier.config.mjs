// ABOUTME: Defines deterministic formatting for BFB's JavaScript and TypeScript files.
// ABOUTME: Keeps formatting policy at the repository root for local and CI use.

/** @type {import("prettier").Config} */
const config = {
  printWidth: 100,
  proseWrap: "preserve",
  semi: true,
  singleQuote: false,
  trailingComma: "all",
};

export default config;
