const BRIDGE_API = "https://api.bridge.xyz";
const TEMPO_RPC = "https://rpc.tempo.xyz";
const PATH_USD_ADDRESS = "0x20c0000000000000000000000000000000000000";
const PATH_USD_DECIMALS = 6;
const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
const UPSTREAM_TIMEOUT_MS = 8_000;

const bridgePaths = {
  supply: "/v0/transparency/path_usd/supply",
  reserves: "/v0/transparency/path_usd/reserves",
  inventory: "/v0/transparency/path_usd/inventory",
  liquidity: "/v0/issuance/reserves/liquidity_allocation",
};

async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return sendJson(response, 405, { error: "Method not allowed" }, "no-store");
  }

  if (!process.env.BRIDGE_API_KEY) {
    return sendJson(response, 500, { error: "Reserve data is not configured" }, "no-store");
  }

  try {
    const report = await fetchReport(process.env.BRIDGE_API_KEY);
    return sendJson(
      response,
      200,
      report,
      "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
    );
  } catch (error) {
    console.error("Unable to refresh pathUSD reserves", error);
    return sendJson(response, 502, { error: "Reserve data is temporarily unavailable" }, "no-store");
  }
}

async function fetchReport(apiKey, fetchImpl = fetch) {
  if (!apiKey) throw new Error("Bridge API key is required");

  const bridgeHeaders = { Accept: "application/json", "Api-Key": apiKey };
  const bridgeRequest = (path) => requestJson(fetchImpl, `${BRIDGE_API}${path}`, { headers: bridgeHeaders });

  const [supplyResponse, reservesResponse, inventoryResponse, liquidityResponse, blockResponse] = await Promise.all([
    bridgeRequest(bridgePaths.supply),
    bridgeRequest(bridgePaths.reserves),
    bridgeRequest(bridgePaths.inventory),
    bridgeRequest(bridgePaths.liquidity),
    rpc(fetchImpl, "eth_blockNumber", [], 1),
  ]);

  const blockHex = requireRpcResult(blockResponse, "block number");
  const totalSupplyResponse = await rpc(
    fetchImpl,
    "eth_call",
    [{ to: PATH_USD_ADDRESS, data: TOTAL_SUPPLY_SELECTOR }, blockHex],
    2,
  );

  return buildReport({
    supplyResponse,
    reservesResponse,
    inventoryResponse,
    liquidityResponse,
    blockHex,
    totalSupplyHex: requireRpcResult(totalSupplyResponse, "total supply"),
  });
}

function buildReport({
  supplyResponse,
  reservesResponse,
  inventoryResponse,
  liquidityResponse,
  blockHex,
  totalSupplyHex,
}) {
  const supply = supplyResponse.supply?.find(
    (entry) => entry.chain === "tempo" && entry.currency === "path_usd",
  );
  if (!supply) throw new Error("Bridge supply response is missing Tempo pathUSD");

  const cash = reservesResponse.accounts?.find(
    (entry) => entry.asset_class === "cash" && entry.currency === "usd",
  );
  const managedMoneyMarket = reservesResponse.accounts?.find(
    (entry) => entry.asset_class === "managed_money_market" && entry.currency === "usd",
  );
  if (!cash || !managedMoneyMarket) throw new Error("Bridge reserves response is incomplete");

  const inventory = inventoryResponse.inventory?.find(
    (entry) =>
      entry.chain === "tempo" && entry.currency?.address?.toLowerCase() === PATH_USD_ADDRESS,
  );
  if (!inventory) throw new Error("Bridge inventory response is missing Tempo pathUSD");

  const supplyUnits = decimalToUnits(supply.amount, PATH_USD_DECIMALS);
  const cashUnits = decimalToUnits(cash.amount, PATH_USD_DECIMALS);
  const managedUnits = decimalToUnits(managedMoneyMarket.amount, PATH_USD_DECIMALS);
  const reserveUnits = cashUnits + managedUnits;
  const onchainUnits = parseHexQuantity(totalSupplyHex, "onchain total supply");
  const inventoryAmount = parseInventoryAmount(inventory.amount);
  const supplyNumber = Number(supplyUnits) / 10 ** PATH_USD_DECIMALS;
  const reserveNumber = Number(reserveUnits) / 10 ** PATH_USD_DECIMALS;
  const cashNumber = Number(cashUnits) / 10 ** PATH_USD_DECIMALS;
  const managedNumber = Number(managedUnits) / 10 ** PATH_USD_DECIMALS;

  if (!Number.isFinite(liquidityResponse.allocation_percent)) {
    throw new Error("Bridge liquidity allocation response is invalid");
  }

  return {
    asOf: new Date().toISOString(),
    asset: {
      symbol: "pathUSD",
      address: PATH_USD_ADDRESS,
      decimals: PATH_USD_DECIMALS,
    },
    supply: {
      bridge: formatUnits(supplyUnits, PATH_USD_DECIMALS),
      onchain: formatUnits(onchainUnits, PATH_USD_DECIMALS),
      matchesOnchain: supplyUnits === onchainUnits,
    },
    reserves: {
      total: formatUnits(reserveUnits, PATH_USD_DECIMALS),
      surplus: formatSignedUnits(reserveUnits - supplyUnits, PATH_USD_DECIMALS),
      coveragePercent: (reserveNumber / supplyNumber) * 100,
      cash: {
        amount: formatUnits(cashUnits, PATH_USD_DECIMALS),
        percent: (cashNumber / reserveNumber) * 100,
      },
      managedMoneyMarket: {
        amount: formatUnits(managedUnits, PATH_USD_DECIMALS),
        percent: (managedNumber / reserveNumber) * 100,
      },
    },
    inventory: {
      amount: inventoryAmount.toFixed(2),
      percentOfSupply: (inventoryAmount / supplyNumber) * 100,
    },
    liquidity: {
      targetPercent: liquidityResponse.allocation_percent,
      minimumRaw: liquidityResponse.allocation_minimum,
    },
    network: {
      chain: "tempo",
      blockNumber: Number(parseHexQuantity(blockHex, "block number")),
    },
  };
}

async function rpc(fetchImpl, method, params, id) {
  return requestJson(fetchImpl, TEMPO_RPC, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

async function requestJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, {
    ...options,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Upstream request failed with status ${response.status}`);
  return response.json();
}

function requireRpcResult(response, label) {
  if (response.error || typeof response.result !== "string") {
    throw new Error(`Tempo RPC returned an invalid ${label}`);
  }
  return response.result;
}

function decimalToUnits(value, decimals) {
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Invalid decimal amount: ${value}`);
  }

  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`Amount has more than ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0"));
}

function formatUnits(value, decimals) {
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function formatSignedUnits(value, decimals) {
  return value < 0n ? `-${formatUnits(-value, decimals)}` : formatUnits(value, decimals);
}

function parseHexQuantity(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error(`Tempo RPC returned an invalid ${label}`);
  }
  return BigInt(value);
}

function parseInventoryAmount(value) {
  if (typeof value !== "string") throw new Error("Bridge inventory amount is invalid");
  const amount = Number(value.replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(amount)) throw new Error("Bridge inventory amount is invalid");
  return amount;
}

function sendJson(response, status, body, cacheControl) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", cacheControl);
  response.end(JSON.stringify(body));
}

module.exports = handler;
module.exports.buildReport = buildReport;
module.exports.fetchReport = fetchReport;
