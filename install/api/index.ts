export const SETUP_SH_URL = "https://raw.githubusercontent.com/neon-solutions/neo/main/setup.sh";

const TEXT_PLAIN = { "content-type": "text/plain; charset=utf-8" };

export const config = { runtime: "edge" };

export async function serveSetup(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed\n", {
      status: 405,
      headers: { ...TEXT_PLAIN, allow: "GET, HEAD" },
    });
  }

  const upstream = await fetch(SETUP_SH_URL);
  if (!upstream.ok) {
    return new Response(`neo: failed to fetch setup.sh (${upstream.status})\n`, {
      status: 502,
      headers: TEXT_PLAIN,
    });
  }

  if (request.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: { ...TEXT_PLAIN, "cache-control": "public, max-age=60" },
    });
  }

  const body = await upstream.text();
  if (!body.startsWith("#!")) {
    return new Response("neo: setup.sh was not a script\n", {
      status: 502,
      headers: TEXT_PLAIN,
    });
  }

  return new Response(body, {
    status: 200,
    headers: { ...TEXT_PLAIN, "cache-control": "public, max-age=60" },
  });
}

export default async function handler(request: Request): Promise<Response> {
  return await serveSetup(request);
}
