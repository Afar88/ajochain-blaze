import { createMainnetApiServer } from "../server/mainnet-api.mjs";

// Shared Node adapter for explicitly routed nested Vercel functions.
// Vercel ignores underscore-prefixed utility modules inside /api.
const server = createMainnetApiServer();
export const handleMainnetApiRequest = server.listeners("request")[0];
