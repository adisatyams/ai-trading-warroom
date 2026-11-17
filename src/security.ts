import type { Env } from "./types";

export function authorized(request: Request, env: Env): boolean {
  const supplied = request.headers.get("x-api-key") || "";
  const expected = env.WARROOM_API_KEY || "";
  if (!expected || supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < supplied.length; i++) {
    diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store" }
  });
}
