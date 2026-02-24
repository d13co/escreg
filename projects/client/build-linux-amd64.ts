#!/usr/bin/env bun

// @ts-ignore - Bun types not available in TypeScript
import { $ } from "bun";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

async function buildExecutable() {
  const distDir = "dist";
  const exeDir = "dist-exe";
  const executableDir = join(exeDir, "executable");

  // Ensure directories exist
  if (!existsSync(executableDir)) {
    mkdirSync(executableDir, { recursive: true });
  }

  console.log("Building TypeScript to JavaScript...");
  await $`npm run build:ts`;

  console.log("Creating standalone executable for Linux x64...");
  
  // Use bun build to create a standalone executable
  await $`bun build ${distDir}/index.js --compile --target=bun-linux-x64 --outfile=${executableDir}/escreg-linux-x64`;

  console.log("✅ Standalone executable created successfully!");
  console.log(`📦 Output: ${executableDir}/escreg-linux-x64`);
  
  // Make it executable
  await $`chmod +x ${executableDir}/escreg-linux-x64`;
  
  // Get file size
  const stats = await $`ls -lh ${executableDir}/escreg-linux-x64`.text();
  console.log(`📊 File info: ${stats.trim()}`);
}

buildExecutable().catch((error) => {
  console.error("❌ Build failed:", error);
  process.exit(1);
});

