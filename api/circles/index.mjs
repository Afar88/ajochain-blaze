export default function handler(request, response) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (request.method !== "POST") {
    response.statusCode = 405;
    response.setHeader("allow", "POST");
    return response.end(JSON.stringify({ error: "Use POST for circle discovery." }));
  }

  // No WizardConnect ownership proof is available. Never read or write the registry.
  response.statusCode = 503;
  return response.end(JSON.stringify({ error: "Shared circle discovery is disabled. Use a circle invite link." }));
}
