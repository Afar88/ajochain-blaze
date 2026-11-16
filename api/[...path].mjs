import { createMainnetApiServer } from "../server/mainnet-api.mjs";

// Vercel Node function adapter: reuse the same guarded HTTP handler without
// opening a persistent listener inside the serverless runtime.
const server = createMainnetApiServer();
const handleRequest = server.listeners("request")[0];

export default function handler(request, response) {
  return handleRequest(request, response);
}
