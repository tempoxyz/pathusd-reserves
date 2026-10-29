import history from "../api/history.js";
import reserves from "../api/reserves.js";

// Static files are served from ./public before this Worker runs. The API
// handlers keep their Vercel (request, response) signature, read secrets from
// process.env (populated by nodejs_compat), and run here through a small adapter.
const routes = {
  "/api/history": history,
  "/api/reserves": reserves,
};

export default {
  async fetch(request, env, ctx) {
    const handler = routes[new URL(request.url).pathname];
    if (!handler) return env.ASSETS.fetch(request);

    if (request.method !== "GET") return runVercelHandler(handler, request);

    // The Cache API stands in for Vercel's s-maxage edge caching. It is a no-op
    // on workers.dev and takes effect once a custom domain is attached.
    const cache = caches.default;
    const cached = await cache.match(request);
    if (cached) return cached;

    const response = await runVercelHandler(handler, request);
    if (response.ok) ctx.waitUntil(cache.put(request, response.clone()));
    return response;
  },
};

async function runVercelHandler(handler, request) {
  const response = {
    statusCode: 200,
    headers: new Headers(),
    body: null,
    setHeader(name, value) {
      this.headers.set(name, value);
    },
    end(body) {
      this.body = body;
    },
  };
  await handler({ method: request.method }, response);
  return new Response(response.body, { status: response.statusCode, headers: response.headers });
}
