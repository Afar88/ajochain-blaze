import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { patchWizardConnectVisibilityHandling } from "./build/wizardconnect-visibility-patch";

function wizardConnectVisibilityRecovery() {
  return {
    name: "ajo-wizardconnect-visibility-recovery",
    apply: "build" as const,
    generateBundle(
      this: { error(message: string): never; info(message: string): void },
      _options: unknown,
      bundle: Record<string, { type: string; code?: string }>,
    ) {
      const candidates = Object.entries(bundle).filter(
        ([, output]) => output.type === "chunk" && typeof output.code === "string" &&
          output.code.includes("maxReconnectAttempts:e.maxReconnectAttempts});return{client:a,uri:o,qrUri:c,credentials:i,events:n,cleanup:b}}"),
      );
      if (candidates.length !== 1) {
        this.error(
          "WizardConnect visibility recovery patch expected one initiateDappRelay chunk; found " +
          candidates.length + ". Refusing to ship the default hidden-tab subscription teardown.",
        );
      }
      const [fileName, output] = candidates[0];
      try {
        output.code = patchWizardConnectVisibilityHandling(output.code!);
      } catch (error) {
        this.error(error instanceof Error ? error.message : String(error));
      }
      this.info("Disabled WizardConnect hidden-tab subscription teardown in " + fileName);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  return {
    base: env.GITHUB_PAGES === "true" ? "/ajochain-blaze/" : "/",
    plugins: [react(), wizardConnectVisibilityRecovery()],
    // libauth initializes embedded BCH cryptography modules with top-level
    // await. Preserve that syntax rather than targeting older browser engines.
    build: {
      target: "esnext",
    },
  };
});
