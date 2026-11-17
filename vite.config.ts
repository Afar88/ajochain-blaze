import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import {
  hasWizardConnectVisibilityTarget,
  patchWizardConnectVisibilityHandling,
} from "./build/wizardconnect-visibility-patch";

function wizardConnectVisibilityRecovery(): Plugin {
  let patched = false;
  return {
    name: "ajo-wizardconnect-visibility-recovery",
    apply: "build",
    enforce: "post",
    renderChunk: {
      order: "post",
      handler(code) {
        if (!hasWizardConnectVisibilityTarget(code)) {
          return null;
        }
        if (patched) {
          this.error("Found more than one WizardConnect initiateDappRelay bundle call. Review the SDK before building.");
        }
        try {
          const patchedCode = patchWizardConnectVisibilityHandling(code);
          patched = true;
          // renderChunk runs before Rollup finalizes content hashes.
          return { code: patchedCode, map: null };
        } catch (error) {
          this.error(error instanceof Error ? error.message : String(error));
        }
      },
    },
    generateBundle() {
      if (!patched) {
        this.error(
          "WizardConnect visibility recovery patch did not find initiateDappRelay. " +
          "Refusing to ship the default hidden-tab subscription teardown.",
        );
      }
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
