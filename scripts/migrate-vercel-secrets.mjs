// One-time copy of the Vercel project's production secrets to the Worker's
// native secrets, without their values ever being displayed or written to disk.
//
// 1. Generates an RSA key pair in memory; the private key never leaves this process.
// 2. Deploys a throwaway function holding only the public key to the Vercel
//    project as an unaliased production deployment (--prod --skip-domain), so
//    it runs with production, not preview, environment variables.
// 3. Fetches the function's output: the variables sealed with AES-256-GCM under
//    a fresh key wrapped with RSA-OAEP-SHA256. Anyone else fetching it gets
//    only ciphertext.
// 4. Decrypts locally and pipes the JSON to `wrangler secret bulk`.
// 5. Removes the throwaway deployment.
//
// Requires `vercel` logged in to the tempoxyz team and `wrangler` logged in to
// the Worker's account. Run from the repository root after the first broker
// deployment has created the Worker:
//
//   node scripts/migrate-vercel-secrets.mjs

import { spawnSync } from "node:child_process";
import {
  constants,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
} from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VERCEL_TEAM = "tempoxyz";
const VERCEL_PROJECT = "pathusd-reserves";
const WORKER = "pathusd-reserves";
const SECRET_NAMES = [
  "BRIDGE_API_KEY",
  "SNOWFLAKE_ACCOUNT",
  "SNOWFLAKE_PRIVATE_KEY",
  "SNOWFLAKE_ROLE",
  "SNOWFLAKE_USER",
  "SNOWFLAKE_WAREHOUSE",
];

export function exportFunctionSource(publicKeyPem, names) {
  return `const { constants, createCipheriv, publicEncrypt, randomBytes } = require("node:crypto");

const PUBLIC_KEY = ${JSON.stringify(publicKeyPem)};
const NAMES = ${JSON.stringify(names)};

module.exports = (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json");
  const missing = NAMES.filter((name) => !process.env[name]);
  if (missing.length) {
    response.statusCode = 500;
    return response.end(JSON.stringify({ missing }));
  }
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(Object.fromEntries(NAMES.map((name) => [name, process.env[name]])));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const wrappedKey = publicEncrypt(
    { key: PUBLIC_KEY, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    key,
  );
  response.end(JSON.stringify({
    key: wrappedKey.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  }));
};
`;
}

export function decryptExport(privateKey, sealed) {
  const key = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(sealed.key, "base64"),
  );
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(sealed.data, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0]} exited with status ${result.status}`);
  return result.stdout ?? "";
}

function main() {
  run("pnpm", ["exec", "wrangler", "deployments", "list", "--name", WORKER], { stdio: ["ignore", "ignore", "inherit"] });

  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 4096 });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });

  const directory = mkdtempSync(join(tmpdir(), "pathusd-secret-export-"));
  let deploymentUrl;
  try {
    mkdirSync(join(directory, "api"));
    writeFileSync(join(directory, "api", "export.js"), exportFunctionSource(publicKeyPem, SECRET_NAMES));

    const vercel = (args) => run("vercel", args, { cwd: directory });
    vercel(["link", "--yes", "--team", VERCEL_TEAM, "--project", VERCEL_PROJECT]);
    deploymentUrl = vercel(["deploy", "--prod", "--skip-domain", "--yes"])
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => line.startsWith("https://"));
    if (!deploymentUrl) throw new Error("vercel deploy did not report a deployment URL");
    console.error(`Deployed throwaway export function to ${deploymentUrl}`);

    const output = vercel(["curl", "/api/export", "--deployment", deploymentUrl, "--yes", "--", "--silent", "--show-error"]);
    const body = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
    if (body.missing) throw new Error(`Production deployment is missing: ${body.missing.join(", ")}`);

    const secrets = decryptExport(privateKey, body);
    const names = Object.keys(secrets).sort();
    if (names.join() !== [...SECRET_NAMES].sort().join() || names.some((name) => !secrets[name])) {
      throw new Error("Decrypted export does not contain exactly the expected non-empty secrets");
    }

    run("pnpm", ["exec", "wrangler", "secret", "bulk", "--name", WORKER], {
      input: JSON.stringify(secrets),
      stdio: ["pipe", "inherit", "inherit"],
    });
    console.error(`Uploaded ${names.join(", ")} to Worker ${WORKER}`);
  } finally {
    if (deploymentUrl) {
      run("vercel", ["remove", deploymentUrl, "--yes", "--scope", VERCEL_TEAM], { stdio: ["ignore", "inherit", "inherit"] });
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
