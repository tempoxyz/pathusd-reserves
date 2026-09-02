const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const INDEX_HTML = path.join(__dirname, "..", "index.html");

/**
 * Loads the dashboard's inline script into an isolated context backed by a
 * minimal DOM stub, and returns both the exported helpers and the recorded
 * element state.
 *
 * The dashboard has no bundler or module boundary, so exercising it means
 * evaluating the same `<script>` the browser evaluates. Everything the script
 * touches at load time is stubbed: `fetch` rejects immediately, which
 * `refreshDashboard` already absorbs via `Promise.allSettled`.
 */
function loadDashboard() {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const scripts = html.match(/<script>([\s\S]*?)<\/script>/g) ?? [];
  assert.equal(scripts.length, 1, "expected exactly one inline script in index.html");
  const source = scripts[0].replace(/^<script>/, "").replace(/<\/script>$/, "");

  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        textContent: "",
        className: "",
        innerHTML: "",
        hidden: false,
        style: {},
        attributes: {},
        children: [],
        setAttribute(name, value) {
          this.attributes[name] = String(value);
        },
        getAttribute(name) {
          return this.attributes[name] ?? null;
        },
        append(...nodes) {
          for (const node of nodes) {
            this.children.push(node);
            this.textContent += node?.textContent ?? String(node);
          }
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
      });
    }
    return elements.get(id);
  };

  const context = {
    console: { error() {}, warn() {}, log() {} },
    Intl,
    Math,
    Number,
    Date,
    JSON,
    Promise,
    String,
    Object,
    Array,
    Error,
    URL,
    isNaN,
    isFinite,
    parseFloat,
    parseInt,
    setTimeout,
    clearTimeout,
    // Every network call fails: the helpers under test are pure, and
    // `refreshDashboard` handles rejection without surfacing it.
    fetch: async () => {
      throw new Error("network disabled in tests");
    },
    document: {
      getElementById: (id) => element(id),
      createTextNode: (text) => ({ textContent: String(text) }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
  };
  context.window = context;
  context.globalThis = context;

  const exported = vm.runInNewContext(
    `${source}\n;({ formatPercent, percentWidth, renderReport, UNAVAILABLE });`,
    context,
    { filename: "index.html#script" },
  );

  return { ...exported, element, elements };
}

test("formatPercent never turns an undefined ratio into a number", () => {
  const { formatPercent, UNAVAILABLE } = loadDashboard();

  // Intl.NumberFormat#format(null) returns "0", which is how a fully
  // collateralised reserve was previously published as "0.00%".
  assert.equal(new Intl.NumberFormat("en-US", { minimumFractionDigits: 2 }).format(null), "0.00");

  assert.equal(formatPercent(null), UNAVAILABLE);
  assert.equal(formatPercent(undefined), UNAVAILABLE);
  assert.equal(formatPercent(Number.NaN), UNAVAILABLE);
  assert.equal(formatPercent(Number.POSITIVE_INFINITY), UNAVAILABLE);
  assert.equal(formatPercent("100"), UNAVAILABLE);

  assert.equal(formatPercent(0), "0.00%");
  assert.equal(formatPercent(100), "100.00%");
  assert.equal(formatPercent(99.6789), "99.68%");
});

test("percentWidth clamps to a valid CSS length and never emits null%", () => {
  const { percentWidth } = loadDashboard();

  assert.equal(percentWidth(null), "0%");
  assert.equal(percentWidth(Number.NaN), "0%");
  assert.equal(percentWidth(-10), "0%");
  assert.equal(percentWidth(0), "0%");
  assert.equal(percentWidth(42.5), "42.5%");
  assert.equal(percentWidth(150), "100%");
});

test("renderReport labels undefined coverage instead of displaying 0.00%", () => {
  const { renderReport, element } = loadDashboard();

  renderReport({
    asOf: "2026-01-01T00:00:00.000Z",
    supply: { bridge: "0", onchain: "0", matchesOnchain: true },
    reserves: {
      total: "5000",
      surplus: "5000",
      coveragePercent: null,
      cash: { amount: "5000", percent: 100 },
      managedMoneyMarket: { amount: "0", percent: 0 },
    },
    inventory: { amount: "0.00", percentOfSupply: null },
    liquidity: { targetPercent: 10, minimumRaw: 100000000 },
    network: { chain: "tempo", blockNumber: 32349463 },
  });

  assert.equal(element("coverage-value").textContent, "n/a");
  assert.notEqual(element("coverage-value").textContent, "0.00%");
  assert.equal(element("inventory-percent").textContent, "n/a of total supply");
  // Defined percentages are still rendered normally.
  assert.equal(element("cash-percent").textContent, "100.00%");
  assert.equal(element("money-market-percent").textContent, "0.00%");
  // Bar widths stay valid CSS lengths.
  assert.equal(element("composition-cash").style.width, "100%");
  assert.equal(element("composition-money").style.width, "0%");
});

test("renderReport renders a fully defined report unchanged", () => {
  const { renderReport, element } = loadDashboard();

  renderReport({
    asOf: "2026-01-01T00:00:00.000Z",
    supply: { bridge: "23985060.599981", onchain: "23985060.599981", matchesOnchain: true },
    reserves: {
      total: "23985060.64",
      surplus: "0.040019",
      coveragePercent: 100.000167,
      cash: { amount: "2359979.1", percent: 9.839 },
      managedMoneyMarket: { amount: "21625081.54", percent: 90.161 },
    },
    inventory: { amount: "70059.83", percentOfSupply: 0.292099 },
    liquidity: { targetPercent: 10, minimumRaw: 100000000 },
    network: { chain: "tempo", blockNumber: 32349463 },
  });

  assert.equal(element("coverage-value").textContent, "100.00%");
  assert.equal(element("cash-percent").textContent, "9.84%");
  assert.equal(element("money-market-percent").textContent, "90.16%");
  assert.equal(element("inventory-percent").textContent, "0.29% of total supply");
  assert.equal(element("inventory-amount").textContent, "70,059.83");
  assert.equal(element("liquidity-target").textContent, "10.00%");
  assert.equal(element("composition-money").style.width, "90.161%");
});
