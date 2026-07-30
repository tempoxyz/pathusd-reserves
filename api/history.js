const {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} = require("node:crypto");

const PATH_USD_ADDRESS = "0x20c0000000000000000000000000000000000000";
const QUERY_TIMEOUT_SECONDS = 45;
const POLL_INTERVAL_MS = 1_000;

const HISTORY_QUERY = `
with supply as (
  select
    date_day,
    max(total_supply) as total_supply
  from TEMPO_CHAIN.MARTS.FACT_DAILY_CIRCULATING_SUPPLY
  where lower(token_address) = '${PATH_USD_ADDRESS}'
  group by date_day
),
daily_transfer_volume as (
  select
    date_day,
    sum(volume_usd) as transfer_volume
  from TEMPO_CHAIN.MARTS.FACT_DAILY_TIP20_VOLUME
  where lower(token_address) = '${PATH_USD_ADDRESS}'
  group by date_day
),
days as (
  select date_day from supply
  union
  select date_day from daily_transfer_volume
)
select
  days.date_day,
  supply.total_supply,
  sum(coalesce(daily_transfer_volume.transfer_volume, 0)) over (
    order by days.date_day rows between unbounded preceding and current row
  ) as cumulative_transfer_volume
from days
left join supply using (date_day)
left join daily_transfer_volume using (date_day)
where supply.total_supply is not null
order by days.date_day
`;

async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return sendJson(response, 405, { error: "Method not allowed" }, "no-store");
  }

  let credentials;
  try {
    credentials = readCredentials(process.env);
  } catch (error) {
    return sendJson(response, 500, { error: "Historical data is not configured" }, "no-store");
  }

  try {
    const history = await fetchHistory(credentials);
    return sendJson(
      response,
      200,
      history,
      "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
    );
  } catch (error) {
    console.error("Unable to refresh pathUSD history", error);
    return sendJson(response, 502, { error: "Historical data is temporarily unavailable" }, "no-store");
  }
}

async function fetchHistory(credentials, fetchImpl = fetch) {
  const statement = await executeStatement(credentials, HISTORY_QUERY, fetchImpl);
  const rows = statement.data;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Snowflake returned no pathUSD history");
  }

  const points = rows.map(([rawDate, rawSupply, rawVolume]) => {
    const date = normalizeDate(rawDate);
    const supply = Number(rawSupply);
    const transferVolume = Number(rawVolume);
    if (!date || !Number.isFinite(supply) || !Number.isFinite(transferVolume)) {
      throw new Error("Snowflake returned malformed pathUSD history");
    }
    return { date, supply, transferVolume };
  });

  return {
    asOf: points.at(-1).date,
    supply: points.map(({ date, supply: value }) => ({ date, value })),
    transferVolume: points.map(({ date, transferVolume: value }) => ({ date, value })),
    source: {
      name: "Tempo Snowflake warehouse",
      supplyTable: "TEMPO_CHAIN.MARTS.FACT_DAILY_CIRCULATING_SUPPLY",
      transferVolumeTable: "TEMPO_CHAIN.MARTS.FACT_DAILY_TIP20_VOLUME",
    },
  };
}

async function executeStatement(credentials, statement, fetchImpl) {
  const baseUrl = `https://${credentials.account}.snowflakecomputing.com/api/v2/statements`;
  const requestBody = {
    statement,
    timeout: QUERY_TIMEOUT_SECONDS,
    database: "TEMPO_CHAIN",
    schema: "MARTS",
    warehouse: credentials.warehouse,
    role: credentials.role,
    parameters: { MULTI_STATEMENT_COUNT: "1", QUERY_TAG: "pathusd-reserves-dashboard" },
  };

  let response = await fetchImpl(baseUrl, {
    method: "POST",
    headers: snowflakeHeaders(credentials),
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout((QUERY_TIMEOUT_SECONDS + 15) * 1_000),
  });

  let data = await response.json();
  if (response.status === 202) {
    const handle = data.statementHandle;
    if (!handle) throw new Error("Snowflake did not return a statement handle");

    for (let elapsed = 0; elapsed < QUERY_TIMEOUT_SECONDS; elapsed += 1) {
      await sleep(POLL_INTERVAL_MS);
      response = await fetchImpl(`${baseUrl}/${handle}`, {
        headers: snowflakeHeaders(credentials),
        signal: AbortSignal.timeout(10_000),
      });
      data = await response.json();
      if (response.status === 200) break;
      if (response.status !== 202) throw new Error(`Snowflake query failed with status ${response.status}`);
    }
  }

  if (!response.ok) throw new Error(`Snowflake query failed with status ${response.status}`);
  if (!Array.isArray(data.data)) throw new Error("Snowflake response is missing query rows");

  const partitions = data.resultSetMetaData?.partitionInfo ?? [];
  if (partitions.length > 1) {
    const handle = data.statementHandle;
    for (let partition = 1; partition < partitions.length; partition += 1) {
      const partitionResponse = await fetchImpl(`${baseUrl}/${handle}?partition=${partition}`, {
        headers: snowflakeHeaders(credentials),
        signal: AbortSignal.timeout(10_000),
      });
      if (!partitionResponse.ok) {
        throw new Error(`Snowflake partition failed with status ${partitionResponse.status}`);
      }
      const partitionData = await partitionResponse.json();
      data.data.push(...(partitionData.data ?? []));
    }
  }

  return data;
}

function snowflakeHeaders(credentials) {
  return {
    Authorization: `Bearer ${createJwt(credentials)}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "pathusd-reserves-dashboard/1.0",
    "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
  };
}

function createJwt(credentials) {
  const privateKey = createPrivateKey(normalizePrivateKey(credentials.privateKey));
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const fingerprint = createHash("sha256").update(publicKey).digest("base64");
  const account = credentials.account.toUpperCase().replaceAll(".", "-");
  const user = credentials.user.toUpperCase();
  const subject = `${account}.${user}`;
  const now = Math.floor(Date.now() / 1_000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: `${subject}.SHA256:${fingerprint}`,
      sub: subject,
      iat: now,
      exp: now + 3_540,
    }),
  );
  const unsignedToken = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(unsignedToken), privateKey);
  return `${unsignedToken}.${base64Url(signature)}`;
}

function readCredentials(environment) {
  const credentials = {
    account: environment.SNOWFLAKE_ACCOUNT,
    user: environment.SNOWFLAKE_USER,
    privateKey: environment.SNOWFLAKE_PRIVATE_KEY,
    warehouse: environment.SNOWFLAKE_WAREHOUSE,
    role: environment.SNOWFLAKE_ROLE,
  };
  const missing = Object.entries(credentials)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) throw new Error(`Missing Snowflake configuration: ${missing.join(", ")}`);
  return credentials;
}

function normalizePrivateKey(value) {
  return value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
}

function normalizeDate(value) {
  if (typeof value !== "string") return null;
  if (/^\d+(\.\d+)?$/.test(value)) {
    return new Date(Number(value) * 1_000).toISOString().slice(0, 10);
  }
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0, 10);
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sendJson(response, status, body, cacheControl) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", cacheControl);
  response.end(JSON.stringify(body));
}

module.exports = handler;
module.exports.fetchHistory = fetchHistory;
