import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Require the complete regular-file set before executing any artifact entrypoint. */
export async function verifyPortableInventory(directory, files) {
  const actual = [];
  async function visit(current, prefix = "") {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory())
        await visit(join(current, entry.name), `${path}/`);
      else if (!entry.isFile())
        throw new Error(
          `Portable inventory contains a non-regular entry: ${path}`,
        );
      else if (path !== "portable.json") actual.push(path);
    }
  }
  await visit(directory);
  assert.deepEqual(
    files.map((file) => file.path).sort(),
    actual.sort(),
    "Portable inventory must match the exact regular-file set",
  );
}
