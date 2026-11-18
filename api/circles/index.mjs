import { handleCircleDiscovery } from "../../server/circle-discovery-api.mjs";

export default function handler(request, response) {
  return handleCircleDiscovery(request, response);
}
