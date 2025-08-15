#!/usr/bin/env bun

// @ts-ignore - Bun types not available in TypeScript
import { $ } from "bun";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

async function buildStandalone() {
  const distDir = "dist";
  const standaloneDir = join(distDir, "standalone");
  
  // Ensure directories exist
  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }
  
  if (!existsSync(standaloneDir)) {
    mkdirSync(standaloneDir, { recursive: true });
  }

  console.log("Building TypeScript to JavaScript...");
  await $`npm run build:ts`;

  console.log("Creating standalone executables for multiple platforms...");
  
  const targets = [
    { platform: "linux", arch: "x64", output: "escreg-linux-x64" },
    { platform: "linux", arch: "arm64", output: "escreg-linux-arm64" },
    { platform: "darwin", arch: "x64", output: "escreg-macos-x64" },
    { platform: "darwin", arch: "arm64", output: "escreg-macos-arm64" },
    { platform: "windows", arch: "x64", output: "escreg-windows-x64.exe" }
  ];

  for (const target of targets) {
    try {
      console.log(`Building for ${target.platform}-${target.arch}...`);
      const bunTarget = `bun-${target.platform}-${target.arch}`;
      const outputPath = join(standaloneDir, target.output);
      
      await $`bun build ${distDir}/index.js --compile --target=${bunTarget} --outfile=${outputPath}`;
      
      if (target.platform !== "windows") {
        await $`chmod +x ${outputPath}`;
      }
      
      console.log(`✅ ${target.output} created successfully`);
    } catch (error) {
      console.warn(`⚠️  Failed to build for ${target.platform}-${target.arch}: ${error}`);
    }
  }

  console.log("📦 Standalone executables created in:", standaloneDir);
  
  // Show file sizes
  try {
    const stats = await $`ls -lh ${standaloneDir}/`.text();
    console.log("📊 File sizes:");
    console.log(stats);
  } catch (error) {
    console.log("Could not display file sizes");
  }
}

buildStandalone().catch((error) => {
  console.error("❌ Build failed:", error);
  process.exit(1);
});

