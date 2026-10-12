#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parse as parseToml } from "smol-toml";
import { verifyPortableInventory } from "./lib/portable-inventory.mjs";

const { values } = parseArgs({ options: { directory: { type: "string" } } });
if (process.platform !== "win32" || !values.directory)
  throw new Error("Use --directory <extracted portable directory> on Windows.");
const directory = resolve(values.directory);
const manifest = JSON.parse(
  await readFile(join(directory, "portable.json"), "utf8"),
);
await verifyPortableInventory(directory, manifest.files);
for (const file of manifest.files) {
  const path = resolve(directory, file.path);
  const within = relative(directory, path);
  if (isAbsolute(within) || within === ".." || within.startsWith("..\\"))
    throw new Error(
      `Inventory path is outside the portable directory: ${file.path}`,
    );
  const bytes = await readFile(path);
  assert.equal(bytes.length, file.size, file.path);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    file.sha256,
    file.path,
  );
}

const workspace = await mkdtemp(join(tmpdir(), "rea-portable-verification-"));
const execute = promisify(execFile);
const node = join(directory, "runtime/node.exe");
const entry = join(directory, "app/scripts/rea.mjs");
let complete = false;
try {
  const sample = join(workspace, "sample");
  await mkdir(sample);
  const source = 'export function greet(name) { return "Hello " + name; }\n';
  await writeFile(join(sample, "app.js"), source, "utf8");
  const guard = join(workspace, "network-guard.cjs");
  await writeFile(
    guard,
    'require("node:net").Socket.prototype.connect = function () { throw new Error("Portable verification forbids Node network connections"); };\n',
    "utf8",
  );
  // This removes package managers and host Node from PATH. The preload rejects
  // Node socket connections; it is not an OS firewall for external executables.
  const environment = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    PATH: join(process.env.SystemRoot, "System32"),
    HOME: workspace,
    USERPROFILE: workspace,
    APPDATA: join(workspace, "Roaming"),
    LOCALAPPDATA: join(workspace, "Local"),
    TEMP: workspace,
    TMP: workspace,
    NODE_OPTIONS: `--require "${guard.replaceAll("\\", "/")}"`,
    npm_command: "exec",
    NO_COLOR: "1",
  };
  const run = async (args) =>
    execute(node, [entry, ...args], {
      cwd: workspace,
      env: environment,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  const launcher = async (args) =>
    execute(
      join(process.env.SystemRoot, "System32/cmd.exe"),
      [
        "/d",
        "/s",
        "/c",
        `""${join(directory, "rea.cmd")}" ${args.map((arg) => `"${arg}"`).join(" ")}"`,
      ],
      {
        cwd: workspace,
        env: environment,
        windowsHide: true,
        windowsVerbatimArguments: true,
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  assert.match(
    (await launcher(["--help"])).stdout,
    /analyze-javascript-application/u,
  );
  const planned = JSON.parse(
    (await launcher(["setup", "--client", "codex", "--dry-run", "--json"]))
      .stdout,
  );
  assert.equal(planned.status, "planned");
  await launcher(["setup", "--client", "codex", "--yes", "--json"]);
  const registration = parseToml(
    await readFile(join(workspace, ".codex/config.toml"), "utf8"),
  ).mcp_servers.rea;
  assert.equal(registration.command, node);
  assert.deepEqual(registration.args, [entry, "mcp"]);
  const cli = JSON.parse(
    (await run(["analyze-javascript-application", sample, "--json"])).stdout,
  );
  assert.equal(cli.operation, "analyze_javascript_application");
  const client = new Client({
    name: "rea-portable-verifier",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: node,
    args: [entry, "mcp"],
    env: environment,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(
      tools.tools.some(({ name }) => name === "analyze_javascript_application"),
    );
    const result = await client.callTool({
      name: "analyze_javascript_application",
      arguments: { input_path: sample },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const payload =
      result.structuredContent ??
      JSON.parse(result.content.find(({ type }) => type === "text").text);
    assert.equal(payload.operation, "analyze_javascript_application");
    assert.deepEqual(payload.normalized_result, cli.normalized_result);
    await client.ping();
  } finally {
    await client.close();
  }
  assert.equal(await readFile(join(sample, "app.js"), "utf8"), source);
  await launcher(["uninstall", "--json"]);
  complete = true;
} finally {
  if (complete) await rm(workspace, { recursive: true, force: true });
  else
    console.error(
      `Verification did not complete; retained workspace: ${workspace}`,
    );
}
console.log(
  JSON.stringify({
    ok: true,
    directory,
    files: manifest.files.length,
    cli: true,
    mcp: true,
    nodeSocketConnections: "denied",
    externalProviders: "not exercised",
  }),
);
