/**
 * Debug entrypoint for Node
 * - works with --inspect-brk
 */

console.log("🐛 Debug mode enabled");

// 👉 你也可以在这里强制断住
// debugger;

await import("./dev-node.ts");