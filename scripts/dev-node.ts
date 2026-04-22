/**
 * Node dev entrypoint (for debugging UI)
 * - Simulates Bun dev behavior
 * - Injects MACRO + FEATURE
 * - Runs cli.tsx in same process (debuggable)
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getMacroDefines, DEFAULT_BUILD_FEATURES } from "./defines.ts";

// ===== 路径解析 =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const cliPath = join(projectRoot, "src/entrypoints/cli.tsx");

// ===== 模拟 Bun 的 define（关键）=====
const defines = getMacroDefines();

for (const [key, value] of Object.entries(defines)) {
  // Bun 的 -d 是编译期宏，这里退化成 runtime env
  process.env[key] = String(value);
}

// ===== 模拟 feature flags（关键）=====
const envFeatures = Object.entries(process.env)
  .filter(([k]) => k.startsWith("FEATURE_"))
  .map(([k]) => k.replace("FEATURE_", ""));

const allFeatures = [
  ...new Set([...DEFAULT_BUILD_FEATURES, ...envFeatures]),
];

// 注入 FEATURE_XXX=1
for (const f of allFeatures) {
  process.env[`FEATURE_${f}`] = "1";
}

// 👉 兜底（防止某些逻辑直接判断 FEATURE_ALL）
process.env.FEATURE_ALL = "1";

// ===== 调试日志 =====
console.log("🚀 Node Debug Mode");
console.log("CLI Path:", cliPath);
console.log("Defines:", defines);
console.log("Features:", allFeatures);

// ===== 捕获异常（非常重要）=====
try {
  await import(cliPath);
} catch (e) {
  console.error("❌ Runtime Error:");
  console.error(e);
  console.error(e?.stack);
  process.exit(1);
}