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
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return;
            if (id.includes("/react/") || id.includes("/react-dom/") ||
                id.includes("/scheduler/")) return "vendor-react";
            if (id.includes("/lucide-react/")) return "vendor-icons";
            if (id.includes("/qrcode/") || id.includes("/pngjs/") ||
                id.includes("/dijkstrajs/")) return "vendor-qrcode";
            if (id.includes("/@wizardconnect/")) return "vendor-wallet-connect";
            if (id.includes("/@bitauth/") || id.includes("/@electrum-cash/") || id.includes("/cashscript/") ||
                id.includes("/cashc/")) return "vendor-bitcoin-cash";
          },
        },
      },
    },
  };
});
