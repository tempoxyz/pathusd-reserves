const assert = require("node:assert/strict");
const test = require("node:test");

const { fetchReport, percentOfUnits } = require("../api/reserves");

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

// Builds a fetch stub from partial Bridge overrides so each regression test can
// vary only the upstream figures it cares about.
function stubFetch({ bridge = {}, onchainSupplyHex = "0x000000000000000000000000000000000000000000000000000015d0750458ad" } = {}) {
  const responses = { ...bridgeResponses, ...bridge };
  return async (url, options = {}) => {
    if (url.startsWith("https://api.bridge.xyz")) {
      return jsonResponse(responses[new URL(url).pathname]);
    }

    const request = JSON.parse(options.body);
    if (request.method === "eth_blockNumber") return jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1ed9d17" });
    if (request.method === "eth_call") return jsonResponse({ jsonrpc: "2.0", id: 2, result: onchainSupplyHex });
    throw new Error(`Unexpected request: ${request.method}`);
  };
}

test("percentOfUnits reports an undefined ratio as null instead of NaN or Infinity", () => {
  // A zero denominator previously produced NaN (0 / 0) or Infinity (n / 0).
  // Both serialise to JSON null, and the dashboard rendered that as "0.00%".
  assert.equal(percentOfUnits(0n, 0n), null);
  assert.equal(percentOfUnits(5_000_000_000n, 0n), null);

  // Defined ratios keep their exact value.
  assert.equal(percentOfUnits(0n, 100n), 0);
  assert.equal(percentOfUnits(50n, 100n), 50);
  assert.equal(percentOfUnits(100n, 100n), 100);
  assert.equal(percentOfUnits(150n, 100n), 150);
  assert.equal(percentOfUnits(-25n, 100n), -25);
});

test("percentOfUnits stays exact above the IEEE-754 safe-integer ceiling", () => {
  // 1e13 pathUSD is 1e19 base units, three orders of magnitude past
  // Number.MAX_SAFE_INTEGER, so the old Number-based path drifted here.
  const supplyUnits = 10_000_000_000_000_000_000n;
  const reserveUnits = supplyUnits + 1n;
  assert.ok(!Number.isSafeInteger(Number(reserveUnits)));
  assert.equal(percentOfUnits(supplyUnits, supplyUnits), 100);
  // One extra base unit on 1e19 is below the 1e-6 percentage-point resolution,
  // so it truncates to exactly 100 rather than rounding away the comparison.
  assert.equal(percentOfUnits(reserveUnits, supplyUnits), 100);
  // A difference the scale can represent is reported, not swallowed.
  assert.equal(percentOfUnits(supplyUnits / 2n, supplyUnits), 50);
});

test("fetchReport publishes null percentages when supply is zero rather than an implied 0%", async () => {
  const fetch = stubFetch({
    bridge: {
      "/v0/transparency/path_usd/supply": {
        supply: [{ chain: "tempo", currency: "path_usd", amount: "0" }],
      },
      "/v0/transparency/path_usd/reserves": {
        accounts: [
          { asset_class: "cash", currency: "usd", amount: "5000" },
          { asset_class: "managed_money_market", currency: "usd", amount: "0" },
        ],
      },
    },
    onchainSupplyHex: "0x0",
  });

  const report = await fetchReport("bridge-secret", fetch);

  assert.equal(report.supply.bridge, "0");
  assert.equal(report.reserves.total, "5000");
  // Reserves exist but there is nothing to collateralise: the ratio is
  // undefined, and must not be published as a finite percentage.
  assert.equal(report.reserves.coveragePercent, null);
  assert.equal(report.inventory.percentOfSupply, null);
  // The reserve composition denominator is non-zero here, so those stay defined.
  assert.equal(report.reserves.cash.percent, 100);
  assert.equal(report.reserves.managedMoneyMarket.percent, 0);

  // JSON.stringify must preserve the explicit null rather than drop the key.
  const serialised = JSON.parse(JSON.stringify(report));
  assert.ok("coveragePercent" in serialised.reserves);
  assert.equal(serialised.reserves.coveragePercent, null);
});

test("fetchReport publishes null composition percentages when reserves are zero", async () => {
  const fetch = stubFetch({
    bridge: {
      "/v0/transparency/path_usd/reserves": {
        accounts: [
          { asset_class: "cash", currency: "usd", amount: "0" },
          { asset_class: "managed_money_market", currency: "usd", amount: "0" },
        ],
      },
    },
  });

  const report = await fetchReport("bridge-secret", fetch);

  assert.equal(report.reserves.total, "0");
  // Zero reserves against a live supply is a real 0% coverage reading, not an
  // undefined one, so it must be reported as the number 0.
  assert.equal(report.reserves.coveragePercent, 0);
  // The composition split of an empty reserve pool is undefined.
  assert.equal(report.reserves.cash.percent, null);
  assert.equal(report.reserves.managedMoneyMarket.percent, null);
});

test("fetchReport keeps reserve arithmetic exact for supplies past the safe-integer ceiling", async () => {
  // 10,000,000,000.5 pathUSD is above Number.MAX_SAFE_INTEGER / 1e6, where the
  // previous Number-based percentage math lost resolution.
  const fetch = stubFetch({
    bridge: {
      "/v0/transparency/path_usd/supply": {
        supply: [{ chain: "tempo", currency: "path_usd", amount: "10000000000.5" }],
      },
      "/v0/transparency/path_usd/reserves": {
        accounts: [
          { asset_class: "cash", currency: "usd", amount: "10000000000.5" },
          { asset_class: "managed_money_market", currency: "usd", amount: "0" },
        ],
      },
    },
    onchainSupplyHex: "0x0",
  });

  const report = await fetchReport("bridge-secret", fetch);

  assert.equal(report.supply.bridge, "10000000000.5");
  assert.equal(report.reserves.surplus, "0");
  assert.equal(report.reserves.coveragePercent, 100);
  assert.equal(report.reserves.cash.percent, 100);
});

test("fetchReport parses inventory amounts into exact units and rejects malformed ones", async () => {
  const negative = await fetchReport(
    "bridge-secret",
    stubFetch({
      bridge: {
        "/v0/transparency/path_usd/inventory": {
          inventory: [
            {
              chain: "tempo",
              currency: { name: "PATH_USD", address: "0x20c0000000000000000000000000000000000000" },
              amount: "-$1,234.5 USD",
            },
          ],
        },
      },
    }),
  );
  // Fixed two-decimal output shape is preserved, including the sign.
  assert.equal(negative.inventory.amount, "-1234.50");
  assert.ok(negative.inventory.percentOfSupply < 0);

  const malformed = stubFetch({
    bridge: {
      "/v0/transparency/path_usd/inventory": {
        inventory: [
          {
            chain: "tempo",
            currency: { name: "PATH_USD", address: "0x20c0000000000000000000000000000000000000" },
            amount: "not a number",
          },
        ],
      },
    },
  });
  await assert.rejects(() => fetchReport("bridge-secret", malformed), /inventory amount is invalid/i);
});
