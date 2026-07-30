const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const test = require("node:test");

const { fetchHistory } = require("../api/history");

test("fetchHistory returns daily pathUSD supply and cumulative peer-to-peer volume", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const credentials = {
    account: "tempo-test",
    user: "dashboard_reader",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    warehouse: "DASHBOARD_WH",
    role: "DATALAND_CHAIN_READER",
  };
  let request;
  const fetch = async (url, options) => {
    request = { url, options };
    return jsonResponse({
      resultSetMetaData: {
        rowType: [
          { name: "DATE_DAY", type: "date" },
          { name: "TOTAL_SUPPLY", type: "fixed" },
          { name: "CUMULATIVE_TRANSFER_VOLUME", type: "fixed" },
        ],
      },
      data: [
        ["1768780800.000000000", "2000.00", "631.99"],
        ["1768867200.000000000", "1999.99", "1763.09"],
      ],
    });
  };

  const history = await fetchHistory(credentials, fetch);

  assert.equal(request.url, "https://tempo-test.snowflakecomputing.com/api/v2/statements");
  assert.match(request.options.headers.Authorization, /^Bearer /);
  assert.equal(request.options.headers["X-Snowflake-Authorization-Token-Type"], "KEYPAIR_JWT");

  const body = JSON.parse(request.options.body);
  assert.equal(body.database, "TEMPO_CHAIN");
  assert.equal(body.schema, "MARTS");
  assert.equal(body.warehouse, "DASHBOARD_WH");
  assert.equal(body.role, "DATALAND_CHAIN_READER");
  assert.match(body.statement, /FACT_DAILY_CIRCULATING_SUPPLY/);
  assert.match(body.statement, /FACT_DAILY_TIP20_VOLUME/);
  assert.match(body.statement, /0x20c0000000000000000000000000000000000000/);

  assert.deepEqual(history.supply, [
    { date: "2026-01-19", value: 2000 },
    { date: "2026-01-20", value: 1999.99 },
  ]);
  assert.deepEqual(history.transferVolume, [
    { date: "2026-01-19", value: 631.99 },
    { date: "2026-01-20", value: 1763.09 },
  ]);
  assert.equal(history.asOf, "2026-01-20");
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}
