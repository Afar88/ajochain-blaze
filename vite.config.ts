import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  return {
    base: env.GITHUB_PAGES === "true" ? "/ajochain-blaze/" : "/",
    plugins: [react()],
    // libauth initializes embedded BCH cryptography modules with top-level
    // await. Preserve that syntax rather than targeting older browser engines.
    build: {
      target: "esnext",
    },
  };
});
