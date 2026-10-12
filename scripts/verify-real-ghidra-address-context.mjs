import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseEvidence } from "../dist/domain/evidence.js";
import { requireMcpOperationResult } from "./lib/mcp-verifier-results.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";

if (process.argv.length !== 2 || process.platform !== "linux")
  throw new Error("Run this ELF verifier on Linux without arguments.");
if (!process.env.GHIDRA_INSTALL_DIR)
  throw new Error("Set GHIDRA_INSTALL_DIR to a caller-installed Ghidra.");
const exec = promisify(execFile);
const run = createVerifierRun();
const root = fileURLToPath(new URL("..", import.meta.url));
const workspace = await mkdtemp(join(tmpdir(), "rea-address-context-"));
const runtime = join(workspace, "runtime");
await mkdir(runtime);
const path = join(workspace, "pie.elf");
const entrypoint = join(root, "scripts/rea.mjs");
const env = {
  ...process.env,
  TMPDIR: runtime,
  REA_ANALYSIS_PROVIDER: "ghidra",
  REA_LOG_LEVEL: "silent",
};
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env,
  stderr: "pipe",
});
const client = new Client({ name: "rea-real-address-context", version: "1" });
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-65536);
});
let report;
let connected = false;
let primaryFailure;
let verifierRun;
try {
  const compiler = process.env.CC ?? "gcc";
  const version = await exec(compiler, ["--version"], { timeout: 10000 });
  await exec(
    compiler,
    [
      "-O0",
      "-g",
      "-fPIE",
      "-pie",
      "-nostdlib",
      "-Wl,-e,rea_pie_entry",
      "-Wl,--build-id=none",
      join(root, "tests/conformance/c/pie-address-context.c"),
      "-o",
      path,
    ],
    { timeout: 30000 },
  );
  const bytes = await readFile(path);
  assert.equal(bytes.subarray(0, 6).toString("hex"), "7f454c460201");
  assert.equal(bytes.readUInt16LE(16), 3); // ET_DYN: source-owned x86-64 PIE.
  assert.equal(bytes.readUInt16LE(18), 62);
  const declaredEntry = `0x${bytes.readBigUInt64LE(24).toString(16)}`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await client.connect(transport);
  connected = true;
  await call("open_binary", { path, provider_id: "ghidra" });
  const overview = parseEvidence(await call("binary_overview"));
  assert.equal(overview.subject.digest.sha256, sha256);
  const base = overview.normalized_result.image_base;
  assert.match(base, /^0x[0-9a-f]+$/u);
  assert.notEqual(base, "0x0");
  const active = await call("binary_session");
  const image = parseEvidence(await call("inspect_native_load_image"));
  assert.equal(base, image.normalized_result.observations.image_base);
  assert.ok(overview.normalized_result.segments.length > 0);
  assert.ok(
    overview.normalized_result.segments.every(
      (segment) =>
        segment.image_base === base &&
        typeof segment.address_space === "string",
    ),
  );
  const procedures = parseEvidence(await call("list_procedures"));
  const entry = procedures.normalized_result.find(
    (item) => item.value === "rea_pie_entry",
  );
  const addition = procedures.normalized_result.find(
    (item) => item.value === "rea_pie_add",
  );
  assert.ok(entry && addition);
  assert.notEqual(entry.address, declaredEntry);
  assert.ok(
    image.normalized_result.observations.entry_points.includes(entry.address),
  );
  const mapping = image.normalized_result.observations.mappings.find(
    (item) =>
      item.source_file_index === 0 &&
      item.file_offset !== null &&
      item.address_space === "ram" &&
      BigInt(item.start) <= BigInt(entry.address) &&
      BigInt(item.end) >= BigInt(entry.address),
  );
  assert.ok(mapping);
  const offset =
    mapping.file_offset + Number(BigInt(entry.address) - BigInt(mapping.start));
  const memory = parseEvidence(
    await call("read_bytes", { address: entry.address, length: 8 }),
  );
  assert.equal(
    memory.normalized_result.bytes_hex,
    bytes.subarray(offset, offset + 8).toString("hex"),
  );
  const rejected = await client.callTool(
    { name: "procedure_pseudo_code", arguments: { procedure: declaredEntry } },
    { timeout: 240000 },
  );
  assert.equal(rejected.isError, true);
  assert.ok(
    JSON.stringify(rejected.content).includes(`Ghidra image base: ${base}`),
  );
  assert.ok(JSON.stringify(rejected.content).includes("list_procedures"));
  assert.ok(
    JSON.stringify(rejected.content).includes("inspect_native_load_image"),
  );
  const pseudo = parseEvidence(
    await call("procedure_pseudo_code", { procedure: addition.address }),
  );
  assert.match(pseudo.normalized_result, /\+\s*(?:7|0x7)\b/u);
  const retained = await call("binary_session");
  assert.equal(retained.analysis_run.run_id, active.analysis_run.run_id);
  await call("close_binary");
  const cli = async (args) =>
    exec(
      process.execPath,
      [entrypoint, ...args, "--provider", "ghidra", "--json"],
      { env, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
    );
  const cliOverview = parseEvidence(
    JSON.parse((await cli(["analyze", path])).stdout),
  );
  assert.deepEqual(cliOverview.normalized_result, overview.normalized_result);
  let cliFailure;
  try {
    await cli(["decompile", path, declaredEntry]);
  } catch (cause) {
    cliFailure = cause;
  }
  assert.ok(cliFailure && typeof cliFailure.stdout === "string");
  const error = JSON.parse(cliFailure.stdout);
  assert.equal(error.code, "invalid_request");
  assert.ok(JSON.stringify(error).includes(`Ghidra image base: ${base}`));
  assert.ok(JSON.stringify(error).includes("list_procedures"));
  assert.ok(JSON.stringify(error).includes("inspect_native_load_image"));
  const cliPseudo = parseEvidence(
    JSON.parse((await cli(["decompile", path, entry.address])).stdout),
  );
  assert.match(cliPseudo.normalized_result, /rea_pie_add/u);
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await readdir(runtime), []);
  report = {
    ok: true,
    mocked: false,
    provider: image.provider,
    compiler: version.stdout.split("\n")[0],
    sha256,
    declared_elf_entry: declaredEntry,
    loaded_entry: entry.address,
    observed_image_base: base,
    cli_mcp_overview_parity: true,
    failed_lookup_guidance: true,
    loaded_decompilation: true,
    source_unchanged: true,
    runtime_cleanup: "complete",
  };
} catch (cause) {
  primaryFailure = { cause };
  if (stderr) process.stderr.write(stderr);
}

const cleanupFailures = [];
// Await provider-owned cleanup before the SDK can terminate its MCP parent.
if (connected) {
  try {
    await call("close_binary");
  } catch (cause) {
    cleanupFailures.push(cause);
  }
}
try {
  await client.close();
} catch (cause) {
  cleanupFailures.push(cause);
}
try {
  await transport.close();
} catch (cause) {
  cleanupFailures.push(cause);
}
try {
  assert.deepEqual(await readdir(runtime), []);
  verifierRun = await completeVerifierRun(run);
  assert.equal(verifierRun.process_lineage.status, "verified");
  assert.deepEqual(verifierRun.process_lineage.descendants, []);
} catch (cause) {
  cleanupFailures.push(cause);
}
if (cleanupFailures.length === 0) {
  try {
    await rm(workspace, { recursive: true, force: true });
  } catch (cause) {
    cleanupFailures.push(cause);
  }
}
if (cleanupFailures.length > 0) {
  process.stderr.write(
    `Retained verifier workspace after cleanup failure: ${workspace}\n`,
  );
  throw new AggregateError(
    primaryFailure === undefined
      ? cleanupFailures
      : [primaryFailure.cause, ...cleanupFailures],
    "Ghidra address-context verifier cleanup failed",
  );
}
if (primaryFailure !== undefined) throw primaryFailure.cause;
process.stdout.write(
  JSON.stringify({ verifier_run: verifierRun, ...report }) + "\n",
);

async function call(name, args = {}) {
  const result = await client.callTool(
    { name, arguments: args },
    { timeout: 240000 },
  );
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return ["open_binary", "binary_session", "close_binary"].includes(name)
    ? requireMcpOperationResult(result, name)
    : result.structuredContent;
}
