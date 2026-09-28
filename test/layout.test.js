const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);

test("page reserves its scrollbar gutter to keep horizontal spacing stable", () => {
  const css = fs.readFileSync(require.resolve("../dashboard.css"), "utf8");
  assert.match(css, /html\s*\{\s*scrollbar-gutter: stable;\s*\}/);
});

test("simplified layout has unique IDs and all render targets exist", () => {
  assert.equal(new Set(ids).size, ids.length);
  for (const match of script.matchAll(/(?:setText|document.getElementById)\("([^"]+)"/g)) {
    assert.ok(ids.includes(match[1]), "Missing render target: " + match[1]);
  }
  assert.doesNotMatch(html, /<footer|section-kicker|class="brand"/);
  assert.match(html, /<summary>Sources and methodology<\/summary>/);
  assert.match(html, /id="reserve-total">—<\/p>/);
});

test("methodology links directly to the token's totalSupply method", () => {
  const methodology = html.match(/<details class="methodology">([\s\S]*?)<\/details>/)[1];
  const href = methodology.match(/<a href="([^"]+)">totalSupply\(\) on Tempo Explorer<\/a>/)[1];
  const url = new URL(href);
  assert.equal(url.origin, "https://explore.tempo.xyz");
  assert.equal(url.pathname, "/address/0x20C0000000000000000000000000000000000000");
  assert.equal(url.searchParams.get("tab"), "interact");
  assert.equal(url.hash, "#totalSupply");
});

test("full-width composition keeps network details inside methodology", () => {
  const methodology = html.match(/<details class="methodology">([\s\S]*?)<\/details>/)[1];
  assert.doesNotMatch(html, /detail-grid|network-title|pathUSD on Tempo/);
  for (const id of ["tempo-block", "inventory-card-amount", "reconciliation-copy"]) {
    assert.ok(methodology.includes(`id="${id}"`));
  }
});

function start(ok) {
  const nodes = new Map();
  const paths = [];
  const element = () => ({
    textContent: "", style: {}, clientWidth: 400,
    set innerHTML(value) { this.textContent = ""; },
    append(text) { this.textContent += text; }, replaceChildren() {},
    setAttribute(name, value) { if (name === "d") paths.push(value); },
  });
  const get = id => {
    assert.ok(ids.includes(id), "Unknown element: " + id);
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const report = {
    asOf: "2026-09-28T12:00:00Z", supply: { bridge: "1000", onchain: "500", matchesOnchain: false },
    reserves: { total: "1001", surplus: "1", coveragePercent: 100.1, cash: { amount: "100", percent: 10 },
      managedMoneyMarket: { amount: "901", percent: 90 }, nonCash: { amount: "901", percent: 90 } },
    inventory: { amount: "10", percentOfSupply: 1 }, liquidity: { targetPercent: 10, minimumRaw: 100 },
    network: { blockNumber: 16, asOf: "2026-09-28T12:00:00Z" },
  };
  const history = { supply: [{ date: "2026-09-28", value: 500 }], transferVolume: [{ date: "2026-09-28", value: 0 }] };
  vm.runInNewContext(script, {
    document: { getElementById: get, createTextNode: text => text, createElementNS: element },
    console: { error() {} }, Intl, Date,
    fetch: async url => ({ ok, status: ok ? 200 : 502, json: async () => url === "/api/history" ? history : report }),
  });
  return { get, paths };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("populated and zero-volume charts render without invalid coordinates", async () => {
  const { get, paths } = start(true);
  await settle();
  assert.equal(get("reserve-total").textContent, "$1,001.00");
  assert.equal(get("coverage-value").textContent, "100.10%");
  assert.equal(get("volume-chart-value").textContent, "$0.00");
  assert.equal(get("report-status").textContent, "Live · supply mismatch");
  assert.equal(get("tempo-block").textContent, "Tempo block 16");
  assert.equal(get("inventory-card-amount").textContent, "10.00 pathUSD");
  assert.equal(get("reconciliation-copy").textContent, "Bridge reports 1000 pathUSD while the contract reports 500 at the reported Tempo block.");
  assert.ok(paths.length >= 4);
  for (const value of paths) assert.doesNotMatch(value, /NaN|Infinity/);
});

test("failed sources do not replace placeholders with financial snapshots", async () => {
  const { get } = start(false);
  await settle();
  assert.equal(get("snapshot-time").textContent, "Reserve data unavailable");
  assert.equal(get("history-status").textContent, "Daily history unavailable");
  assert.equal(get("reserve-total").textContent, "");
  assert.equal(get("coverage-value").textContent, "");
});
