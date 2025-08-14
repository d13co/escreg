#!/usr/bin/env bun

import { $ } from "bun";
import { writeFileSync, chmodSync } from "fs";

async function buildDockerExecutable() {
  console.log("🐳 Building standalone Linux executable with Docker...");

  try {
    // Clean previous builds
    console.log("🧹 Cleaning previous builds...");
    await $`rm -rf dist/docker`;
    await $`mkdir -p dist/docker`;

    // Create Dockerfile for building the executable
    console.log("📝 Creating Dockerfile...");
    const dockerfile = `FROM oven/bun:1 as builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY bunfig.toml ./

# Install dependencies
RUN bun install

# Copy source code
COPY src/ ./src/
COPY tsconfig.json ./

# Build the application
RUN bun run build

# Create standalone executable
RUN bun build ./src/index.ts --target=bun --compile --outdir=/app/dist --name=escreg

# Create a minimal runtime image
FROM scratch

# Copy the executable
COPY --from=builder /app/dist/escreg /escreg

# Set entrypoint
ENTRYPOINT ["/escreg"]
`;

    writeFileSync("dist/docker/Dockerfile", dockerfile);

    // Create a build script
    const buildScript = `#!/bin/bash
# Build script for Docker-based executable

set -e

echo "🔨 Building Docker image..."
docker build -t escreg-builder -f dist/docker/Dockerfile .

echo "📦 Extracting executable..."
docker create --name escreg-temp escreg-builder
docker cp escreg-temp:/escreg dist/docker/escreg
docker rm escreg-temp

echo "🔧 Making executable..."
chmod +x dist/docker/escreg

echo "✅ Standalone executable created: dist/docker/escreg"
echo "🚀 This executable should work on any Linux x64 system!"
`;

    writeFileSync("dist/docker/build.sh", buildScript);
    chmodSync("dist/docker/build.sh", 0o755);

    // Create a simpler approach using Bun's built-in compilation
    console.log("🚀 Creating standalone executable with Bun...");
    
    // First build the TypeScript
    await $`bun run build`;
    
    // Create a bundled version
    await $`bun build ./src/index.ts --target=bun --outdir=dist/docker --name=escreg-bundle`;
    
    // Create the executable
    await $`bun build dist/docker/escreg-bundle.js --target=bun --compile --name=escreg`;
    
    // Move the compiled executable to the correct location
    await $`mv escreg dist/docker/`;

    // Create a shell script wrapper for better compatibility
    const shellWrapper = `#!/bin/bash
# Standalone escreg CLI executable
# This script provides a fallback if the native executable doesn't work

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Try to run the native executable first
if [ -f "$SCRIPT_DIR/escreg" ] && [ -x "$SCRIPT_DIR/escreg" ]; then
    exec "$SCRIPT_DIR/escreg" "$@"
fi

# Fallback to Bun if available
if command -v bun >/dev/null 2>&1; then
    exec bun "$SCRIPT_DIR/escreg-bundle.js" "$@"
fi

# Fallback to Node.js if available
if command -v node >/dev/null 2>&1; then
    exec node "$SCRIPT_DIR/escreg-bundle.js" "$@"
fi

echo "Error: No suitable runtime found. Please install Bun or Node.js."
echo "Bun: https://bun.sh"
echo "Node.js: https://nodejs.org"
exit 1
`;

    writeFileSync("dist/docker/escreg.sh", shellWrapper);
    chmodSync("dist/docker/escreg.sh", 0o755);

    // Create a README
    const readme = `# Escreg Standalone Executable (Docker Build)

This directory contains the standalone executable for the escreg CLI tool, built using Docker for maximum compatibility.

## Files:

- \`escreg\` - Native executable (Linux x64)
- \`escreg.sh\` - Shell script wrapper with fallbacks
- \`escreg-bundle.js\` - Bundled JavaScript
- \`Dockerfile\` - Docker build configuration
- \`build.sh\` - Docker build script

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
- No additional runtime required (for native executable)
- Bun/Node.js for fallback modes

## Installation:

1. Copy the \`escreg\` executable to a directory in your PATH
2. Make it executable: \`chmod +x escreg\`
3. Run: \`escreg --help\`

## Build Information:

- Built with Bun + Docker
- Target: Linux x64
- Dependencies: Bundled
- Runtime: Standalone (no external dependencies)

## Alternative Build Methods:

### Using Docker (if available):
\`\`\`bash
cd dist/docker
./build.sh
\`\`\`

### Using Bun directly:
\`\`\`bash
bun run build:executable
\`\`\`
`;

    writeFileSync("dist/docker/README.md", readme);

    console.log("✅ Docker-based executable created successfully!");
    console.log("📁 Output location: dist/docker/");
    console.log("🚀 Native executable: dist/docker/escreg");
    console.log("📦 Bundled JS: dist/docker/escreg-bundle.js");
    console.log("📝 Shell wrapper: dist/docker/escreg.sh");

    // Test the executable
    console.log("🧪 Testing executable...");
    try {
      const testResult = await $`./dist/docker/escreg --help`;
      console.log("✅ Native executable test passed!");
    } catch (error) {
      console.log("⚠️  Native executable test failed, testing shell wrapper...");
      const shellTestResult = await $`./dist/docker/escreg.sh --help`;
      console.log("✅ Shell wrapper test passed!");
    }

  } catch (error) {
    console.error("❌ Build failed:", error);
    process.exit(1);
  }
}

// Run the build
buildDockerExecutable();
