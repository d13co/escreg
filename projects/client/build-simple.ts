#!/usr/bin/env bun

import { $ } from "bun";
import { writeFileSync, chmodSync } from "fs";

async function buildSimpleExecutable() {
  console.log("🔨 Building simple standalone Linux executable...");

  try {
    // Clean previous builds
    console.log("🧹 Cleaning previous builds...");
    await $`rm -rf dist/simple`;
    await $`mkdir -p dist/simple`;

    // First, build the TypeScript project
    console.log("📦 Building TypeScript project...");
    await $`bun run build`;

    // Create the standalone executable from the compiled JavaScript
    console.log("🚀 Creating standalone executable...");
    await $`cd /tmp && bun build ${process.cwd()}/dist/index.js --target=bun --compile --name=escreg-cli`;
    
    // Move the compiled executable to the correct location
    await $`mv /tmp/escreg-cli dist/simple/escreg`;

    // Create a shell script wrapper for better compatibility
    const shellWrapper = `#!/bin/bash
# Standalone escreg CLI executable wrapper
# This script provides a fallback if the native executable doesn't work

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Try to run the native executable first
if [ -f "$SCRIPT_DIR/escreg" ] && [ -x "$SCRIPT_DIR/escreg" ]; then
    exec "$SCRIPT_DIR/escreg" "$@"
fi

# Fallback to Bun if available
if command -v bun >/dev/null 2>&1; then
    echo "Native executable not found, falling back to Bun..."
    exec bun "$SCRIPT_DIR/../index.js" "$@"
fi

# Fallback to Node.js if available
if command -v node >/dev/null 2>&1; then
    echo "Native executable not found, falling back to Node.js..."
    exec node "$SCRIPT_DIR/../index.js" "$@"
fi

echo "Error: No suitable runtime found. Please install Bun or Node.js."
echo "Bun: https://bun.sh"
echo "Node.js: https://nodejs.org"
exit 1
`;

    writeFileSync("dist/simple/escreg.sh", shellWrapper);
    chmodSync("dist/simple/escreg.sh", 0o755);

    // Create a README
    const readme = `# Escreg Standalone Executable (Simple Build)

This directory contains the standalone executable for the escreg CLI tool.

## Files:

- \`escreg\` - Native executable (Linux x64)
- \`escreg.sh\` - Shell script wrapper with fallbacks

## Usage:

### Native Executable:
\`\`\`bash
./escreg --help
./escreg register 123,456,789
./escreg lookup ADDRESS1,ADDRESS2
./escreg convert 123,456,789
\`\`\`

### Shell Script Wrapper:
\`\`\`bash
./escreg.sh --help
\`\`\`

## Requirements:

- Linux x64 system
- Bun runtime (for native executable)
- Bun/Node.js for fallback modes

## Installation:

1. Copy the \`escreg\` executable to a directory in your PATH
2. Make it executable: \`chmod +x escreg\`
3. Run: \`escreg --help\`

## Build Information:

- Built with Bun
- Target: Linux x64
- Dependencies: Bundled
- Runtime: Bun

## Build Command:

\`\`\`bash
bun run build:simple
\`\`\`
`;

    writeFileSync("dist/simple/README.md", readme);

    console.log("✅ Simple standalone executable created successfully!");
    console.log("📁 Output location: dist/simple/");
    console.log("🚀 Native executable: dist/simple/escreg");
    console.log("📝 Shell wrapper: dist/simple/escreg.sh");

    // Test the executable
    console.log("🧪 Testing executable...");
    try {
      const testResult = await $`./dist/simple/escreg --help`;
      console.log("✅ Native executable test passed!");
    } catch (error) {
      console.log("⚠️  Native executable test failed, testing shell wrapper...");
      const shellTestResult = await $`./dist/simple/escreg.sh --help`;
      console.log("✅ Shell wrapper test passed!");
    }

  } catch (error) {
    console.error("❌ Build failed:", error);
    process.exit(1);
  }
}

// Run the build
buildSimpleExecutable();
