const assert = require("node:assert/strict");
const test = require("node:test");

const { fetchReport } = require("../api/reserves");

const bridgeResponses = {
  "/v0/transparency/path_usd/supply": {
    supply: [{ chain: "tempo", currency: "path_usd", amount: "23985060.599981" }],
  },
  "/v0/transparency/path_usd/reserves": {
    accounts: [
      { asset_class: "cash", currency: "usd", amount: "2359979.1" },
      { asset_class: "managed_money_market", currency: "usd", amount: "21625081.54" },
    ],
  },
  "/v0/transparency/path_usd/inventory": {
    inventory: [
      {
        chain: "tempo",
        currency: {
          name: "PATH_USD",
          address: "0x20c0000000000000000000000000000000000000",
        },
        amount: "$70,059.83 USD",
      },
    ],
  },
  "/v0/issuance/reserves/liquidity_allocation": {
    allocation_minimum: 100000000,
    allocation_percent: 10,
  },
};

test("fetchReport reconciles Bridge reserves with pathUSD supply at one Tempo block", async () => {
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });

    if (url.startsWith("https://api.bridge.xyz")) {
      const path = new URL(url).pathname;
      return jsonResponse(bridgeResponses[path]);
    }

    const request = JSON.parse(options.body);
    if (request.method === "eth_blockNumber") return jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1ed9d17" });
    if (request.method === "eth_call") {
      assert.equal(request.params[1], "0x1ed9d17");
      return jsonResponse({ jsonrpc: "2.0", id: 2, result: "0x000000000000000000000000000000000000000000000000000015d0750458ad" });
    }

    throw new Error(`Unexpected request: ${request.method}`);
  };

  const report = await fetchReport("bridge-secret", fetch);

  assert.equal(report.supply.bridge, "23985060.599981");
  assert.equal(report.supply.onchain, "23985060.599981");
  assert.equal(report.supply.matchesOnchain, true);
  assert.equal(report.reserves.total, "23985060.64");
  assert.equal(report.reserves.surplus, "0.040019");
  assert.equal(report.reserves.cash.amount, "2359979.1");
  assert.equal(report.reserves.managedMoneyMarket.amount, "21625081.54");
  assert.equal(report.inventory.amount, "70059.83");
  assert.equal(report.liquidity.targetPercent, 10);
  assert.equal(report.network.blockNumber, 32349463);

  const bridgeRequests = requests.filter(({ url }) => url.startsWith("https://api.bridge.xyz"));
  assert.equal(bridgeRequests.length, 4);
  assert.ok(bridgeRequests.every(({ options }) => options.headers["Api-Key"] === "bridge-secret"));
  assert.ok(requests.filter(({ url }) => url === "https://rpc.tempo.xyz").every(({ options }) => !options.headers["Api-Key"]));
});

test("fetchReport rejects malformed upstream data instead of publishing partial figures", async () => {
  const fetch = async (url, options = {}) => {
    if (url.endsWith("/supply")) return jsonResponse({ supply: [] });
    if (url.startsWith("https://api.bridge.xyz")) return jsonResponse(bridgeResponses[new URL(url).pathname]);
    return jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1" });
  };

  await assert.rejects(() => fetchReport("bridge-secret", fetch), /supply/i);
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}
