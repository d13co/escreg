import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // the generated client and the network defaults are not this suite's to cover
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**", "src/types.ts"],
    },
  },
});
