import assert from "node:assert/strict";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupOwnedProcessGroup } from "../../dist/process/ProcessOwnership.js";
import { observeOwnedProcessGroups } from "../../dist/process/ProcessOwnershipObservation.js";

export const describeError = (error) => ({
  name: error?.name ?? "Error",
  message: error?.message ?? String(error),
  ...(error?.stack ? { stack: error.stack } : {}),
});

export async function attemptAll(actions) {
  const failures = [];
  for (const [name, action] of actions) {
    try {
      await action();
    } catch (error) {
      failures.push({ action: name, ...describeError(error) });
    }
  }
  return failures;
}

async function latest(root, report) {
  const temporary = join(root, `.verification-${report.run_id}.tmp`);
  await writeFile(temporary, JSON.stringify(report, null, 2), { flag: "wx" });
  await rename(temporary, join(root, "verification-latest.json"));
}

export async function prepareAttempt(root, inspectExisting, run) {
  if (!inspectExisting) await mkdir(root, { mode: 0o700 });
  const directory = join(root, "verifications", run.run_id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Preserve older reports as history, without leaving an ambiguous success at
  // the capture root. Never delete caller-owned evidence.
  try {
    await rename(
      join(root, "verification.json"),
      join(directory, "legacy-verification.json"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await latest(root, {
    run_id: run.run_id,
    status: "running",
    started_at: new Date().toISOString(),
    directory,
  });
  return { directory, captureRoot: join(root, "captures") };
}

export async function publishAttempt(root, directory, report) {
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify(report, null, 2),
    { flag: "wx" },
  );
  if (report.status === "passed")
    await writeFile(
      join(directory, "verification.json"),
      JSON.stringify(report, null, 2),
      { flag: "wx" },
    );
  await latest(root, {
    run_id: report.run_id,
    status: report.status,
    directory,
    finished_at: report.finished_at,
  });
}

export async function finishProducerGroups(captureRoot, runId) {
  let leases;
  try {
    leases = (await readFile(join(captureRoot, "process-groups.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  } catch (error) {
    if (error.code === "ENOENT") return { groups: [], observation: [] };
    throw error;
  }
  for (const lease of leases) assert.equal(lease.runId, runId);
  const failures = await attemptAll(
    leases.map((lease) => [
      `producer-group-${lease.processGroupId}`,
      async () => {
        const result = await cleanupOwnedProcessGroup(lease);
        assert.equal(result.cleaned, true, JSON.stringify(result));
      },
    ]),
  );
  // Inspect even when one close failed; the groups can outlive their bootloader
  // parent and disappear from a plain descendant-only observation.
  const observation = [
    ...(await observeOwnedProcessGroups(
      runId,
      leases.map((lease) => lease.processGroupId),
    )),
  ];
  return { groups: leases, failures, observation };
}
