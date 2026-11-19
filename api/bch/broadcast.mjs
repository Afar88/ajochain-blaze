import { handleMainnetApiRequest } from "../_mainnet-api-handler.mjs";

export default function handler(request, response) {
  return handleMainnetApiRequest(request, response);
}
