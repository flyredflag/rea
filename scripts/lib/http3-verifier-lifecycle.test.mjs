import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  attemptAll,
  prepareAttempt,
  publishAttempt,
  finishProducerGroups,
} from "./http3-verifier-lifecycle.mjs";
import { cleanupOwnedProcessGroup } from "../../dist/process/ProcessOwnership.js";
import { verifyConcurrency } from "./http3-capture-assertions.mjs";

test("cleanup continues through failed closes and reaches its audit", async () => {
  const attempted = [];
  const failures = await attemptAll(
    ["client", "transport", "audit"].map((name) => [
      name,
      async () => {
        attempted.push(name);
        if (name !== "audit") throw new Error(`${name} failed`);
      },
    ]),
  );
  assert.deepEqual(attempted, ["client", "transport", "audit"]);
  assert.deepEqual(
    failures.map((failure) => failure.action),
    ["client", "transport"],
  );
});

test("a failed reinspection cannot leave the earlier success as the current result", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-http3-results-"));
  try {
    await writeFile(
      join(root, "verification.json"),
      '{"status":"passed","run_id":"legacy"}',
    );
    const first = await prepareAttempt(root, true, { run_id: "first" });
    await publishAttempt(root, first.directory, {
      run_id: "first",
      status: "passed",
    });
    const next = await prepareAttempt(root, true, { run_id: "next" });
    assert.equal(
      JSON.parse(await readFile(join(root, "verification-latest.json"))).status,
      "running",
    );
    await publishAttempt(root, next.directory, {
      run_id: "next",
      status: "failed",
      error: { message: "new failure" },
    });
    assert.equal(
      JSON.parse(await readFile(join(root, "verification-latest.json"))).run_id,
      "next",
    );
    assert.equal(
      JSON.parse(await readFile(join(root, "verification-latest.json"))).status,
      "failed",
    );
    await assert.rejects(readFile(join(next.directory, "verification.json")), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(join(root, "verification.json")), {
      code: "ENOENT",
    });
    assert.equal(
      JSON.parse(await readFile(join(first.directory, "verification.json")))
        .status,
      "passed",
    );
    assert.equal(
      JSON.parse(
        await readFile(join(first.directory, "legacy-verification.json")),
      ).run_id,
      "legacy",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatch reverses origin completion; client and capture may arrive in other orders", () => {
  const names = ["parallel-0", "parallel-1", "parallel-2"];
  const header = (text) => ({ base64: Buffer.from(text).toString("base64") });
  const messages = Object.fromEntries(
    names.map((name) => [
      name,
      {
        headers: [[header("x-lab-case"), header(name)]],
        body: { base64: header(name).base64 },
      },
    ]),
  );
  const event = (kind, index, connection, monotonic) => ({
    event: kind,
    case: names[index],
    stream_id: index * 4,
    connection,
    monotonic,
    ...messages[names[index]],
  });
  const manifest = {
    requests: messages,
    responses: messages,
    events: [
      ...[0, 1, 2].map((i) => event("request-sent", i, "client", i)),
      ...[1, 2, 0].map((i) => event("request-received", i, "origin", 10)),
      ...[0, 2, 1].map((i) => event("response-sent", i, "origin", 20)),
      ...[2, 0, 1].map((i) => event("response-received", i, "client", 30)),
      ...["client", "origin"].map((connection) => ({
        event: "handshake",
        connection,
        alpn: "h3",
        quic_version: 1,
      })),
    ],
  };
  const record = (name) => ({
    reported: {
      id: name,
      request: { headers: [["x-lab-case", name]] },
      client_conn: { id: "client-uuid" },
      server_conn: { id: "origin-uuid" },
    },
  });
  const normal = {
    records: [...[1, 0, 2].map((i) => record(names[i])), record("curl")],
  };
  const orders = verifyConcurrency(normal, manifest);
  assert.deepEqual(orders.dispatched_at_origin, [
    "parallel-0",
    "parallel-2",
    "parallel-1",
  ]);
  manifest.events = manifest.events.filter(
    (item) => item.event !== "response-sent",
  );
  manifest.events.push(
    ...[2, 1, 0].map((i) => event("response-sent", i, "origin", 20)),
  );
  assert.throws(() => verifyConcurrency(normal, manifest), {
    code: "ERR_ASSERTION",
  });
});

test("cleanup verifies and retires a separately owned producer group", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-http3-group-"));
  const runId = randomUUID();
  const child = spawn("/usr/bin/sleep", ["60"], {
    detached: true,
    env: { ...process.env, REA_PROCESS_RUN_ID: runId },
    stdio: "ignore",
  });
  let primaryError;
  let cleaned = false;
  try {
    await once(child, "spawn");
    await writeFile(
      join(root, "process-groups.jsonl"),
      JSON.stringify({
        runId,
        leaderPid: child.pid,
        processGroupId: child.pid,
      }) + "\n",
    );
    const result = await finishProducerGroups(root, runId);
    assert.deepEqual(result.failures, []);
    assert.equal(result.observation[0][1].state, "empty");
  } catch (error) {
    primaryError = error;
  } finally {
    const failures = await attemptAll([
      [
        "process",
        async () => {
          const result = await cleanupOwnedProcessGroup({
            runId,
            leaderPid: child.pid,
            processGroupId: child.pid,
          });
          assert.equal(
            result.cleaned,
            true,
            `Retained ownership evidence at ${root}: ${JSON.stringify(result)}`,
          );
          cleaned = true;
        },
      ],
      [
        "root",
        async () => {
          if (cleaned) await rm(root, { recursive: true, force: true });
        },
      ],
    ]);
    if (failures.length)
      primaryError ??= new AggregateError(failures, "Test cleanup failed");
  }
  if (primaryError) throw primaryError;
});
