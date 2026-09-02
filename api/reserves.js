const BRIDGE_API = "https://api.bridge.xyz";
const TEMPO_RPC = "https://rpc.tempo.xyz";
const PATH_USD_ADDRESS = "0x20c0000000000000000000000000000000000000";
const PATH_USD_DECIMALS = 6;
const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
const UPSTREAM_TIMEOUT_MS = 8_000;
// Fixed-point scale used to derive percentages in BigInt before narrowing to
// `Number`. 1e6 keeps six fractional digits of a percentage point, which is far
// more resolution than the two digits the dashboard renders, and the scaled
// result stays well inside the safe-integer range for any realistic ratio.
const PERCENT_SCALE = 1_000_000n;

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

  // Every monetary quantity stays in integer base units (BigInt) for the whole
  // computation. Converting to IEEE-754 `Number` before dividing silently loses
  // precision above Number.MAX_SAFE_INTEGER / 10 ** PATH_USD_DECIMALS
  // (~9.007e9 pathUSD), which is inside the plausible supply range for a
  // stablecoin. Ratios are therefore derived by `percentOfUnits` below.
  const supplyUnits = decimalToUnits(supply.amount, PATH_USD_DECIMALS);
  const cashUnits = decimalToUnits(cash.amount, PATH_USD_DECIMALS);
  const managedUnits = decimalToUnits(managedMoneyMarket.amount, PATH_USD_DECIMALS);
  const reserveUnits = cashUnits + managedUnits;
  const onchainUnits = parseHexQuantity(totalSupplyHex, "onchain total supply");
  const inventoryUnits = parseInventoryAmount(inventory.amount, PATH_USD_DECIMALS);

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
      // `null` (not 0, NaN or Infinity) whenever the denominator is zero, so a
      // consumer can distinguish "no data" from a genuine 0% reading.
      coveragePercent: percentOfUnits(reserveUnits, supplyUnits),
      cash: {
        amount: formatUnits(cashUnits, PATH_USD_DECIMALS),
        percent: percentOfUnits(cashUnits, reserveUnits),
      },
      managedMoneyMarket: {
        amount: formatUnits(managedUnits, PATH_USD_DECIMALS),
        percent: percentOfUnits(managedUnits, reserveUnits),
      },
    },
    inventory: {
      amount: formatFixedUnits(inventoryUnits, PATH_USD_DECIMALS, 2),
      percentOfSupply: percentOfUnits(inventoryUnits, supplyUnits),
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

/**
 * Formats integer base units as a decimal string with a fixed number of
 * fraction digits, truncating (never rounding up) any extra precision. This
 * preserves the exact output shape of the previous `Number#toFixed(2)` call
 * while keeping the underlying arithmetic in BigInt.
 *
 * @param {bigint} value Amount in base units.
 * @param {number} decimals Base-unit exponent of `value`.
 * @param {number} fractionDigits Fraction digits to emit.
 * @returns {string} Decimal string, sign-prefixed when negative.
 */
function formatFixedUnits(value, decimals, fractionDigits) {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const whole = magnitude / divisor;
  const fraction = (magnitude % divisor).toString().padStart(decimals, "0").slice(0, fractionDigits);
  const body = fractionDigits > 0 ? `${whole}.${fraction.padEnd(fractionDigits, "0")}` : whole.toString();
  return negative ? `-${body}` : body;
}

/**
 * Computes `numerator / denominator * 100` without ever producing `NaN` or
 * `Infinity`.
 *
 * Both inputs are integer base units, so the ratio is evaluated entirely in
 * BigInt and only the final scaled result is narrowed to `Number`. That keeps
 * the percentage exact for supplies far beyond the ~9.007e9 pathUSD ceiling at
 * which `Number(units) / 10 ** decimals` starts to drift.
 *
 * Returning `null` for a zero denominator is deliberate. The previous code
 * divided by zero, yielding `NaN` (0 / 0) or `Infinity` (n / 0); both serialise
 * to JSON `null` anyway, but as an *undeclared* null that the dashboard fed
 * straight into `Intl.NumberFormat#format`, which renders it as "0.00%". A
 * fully collateralised reserve would therefore have been published as 0.00%
 * coverage. Making the null explicit lets callers detect and label the case.
 *
 * @param {bigint} numeratorUnits Amount in base units.
 * @param {bigint} denominatorUnits Amount in base units.
 * @returns {number|null} Percentage, or `null` when the ratio is undefined.
 */
function percentOfUnits(numeratorUnits, denominatorUnits) {
  if (denominatorUnits === 0n) return null;
  const scaled = (numeratorUnits * 100n * PERCENT_SCALE) / denominatorUnits;
  return Number(scaled) / Number(PERCENT_SCALE);
}

function parseHexQuantity(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error(`Tempo RPC returned an invalid ${label}`);
  }
  return BigInt(value);
}

/**
 * Parses a human-formatted Bridge inventory amount (for example
 * `"$70,059.83 USD"`) into integer base units.
 *
 * Returning BigInt units rather than a `Number` keeps the value on the same
 * exact-integer footing as every other monetary quantity in the report, so the
 * inventory percentage can be derived by `percentOfUnits`.
 *
 * @param {unknown} value Raw Bridge inventory amount.
 * @param {number} decimals Base-unit exponent to scale to.
 * @returns {bigint} Amount in base units.
 */
function parseInventoryAmount(value, decimals) {
  if (typeof value !== "string") throw new Error("Bridge inventory amount is invalid");
  // Strip currency symbols, thousands separators and the trailing currency code,
  // keeping only an optional leading sign and the decimal digits.
  const sanitized = value.replace(/[^0-9.\-]/g, "");
  const match = /^(-?)(\d+(?:\.\d+)?)$/.exec(sanitized);
  if (!match) throw new Error("Bridge inventory amount is invalid");
  const [, sign, magnitude] = match;
  const units = decimalToUnits(magnitude, decimals);
  return sign === "-" ? -units : units;
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
module.exports.percentOfUnits = percentOfUnits;
