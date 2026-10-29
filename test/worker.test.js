const assert = require("node:assert/strict");
const test = require("node:test");

test("worker serves static assets for non-API paths", async () => {
  const { default: worker } = await import("../src/worker.mjs");
  const request = new Request("https://pathusd-reserves.example/dashboard.css");
  const env = { ASSETS: { fetch: async (forwarded) => new Response(new URL(forwarded.url).pathname) } };

  const response = await worker.fetch(request, env, {});

  assert.equal(await response.text(), "/dashboard.css");
});

test("worker adapts the Vercel API handlers to Responses", async () => {
  const { default: worker } = await import("../src/worker.mjs");
  const request = new Request("https://pathusd-reserves.example/api/reserves", { method: "POST" });

  const response = await worker.fetch(request, {}, {});

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "GET");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { error: "Method not allowed" });
});
