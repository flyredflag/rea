import { afterEach, expect, it } from "vitest";
import {
  closeEnhancedToolResources,
  connect,
  jsonResult,
} from "./enhancedToolsHarness.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";
import type { SegmentSummary } from "../../../src/domain/hopperValues.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

afterEach(closeEnhancedToolResources);

const segment = {
  name: ".text",
  start: "0x101000",
  end: "0x101100",
  readable: true,
  writable: false,
  executable: true,
  image_base: "0x100000",
  address_space: "ram",
};

const overviewClient = (segments: SegmentSummary[]) =>
  connect({
    execute: (name) => {
      switch (name) {
        case "current_document":
          return Promise.resolve(ok("fixture"));
        case "list_documents":
          return Promise.resolve(ok(["fixture"]));
        case "list_segments":
          return Promise.resolve(ok(segments));
        case "list_procedures":
          return Promise.resolve(ok([{ address: "0x101013", value: "entry" }]));
        case "list_strings":
          return Promise.resolve(ok([]));
        default:
          throw new Error(`Unexpected operation: ${name}`);
      }
    },
  });

it("preserves the observed image base rather than guessing it from the first segment", async () => {
  const client = await overviewClient([segment]);
  expect(
    jsonResult(
      await client.callTool({ name: "binary_overview", arguments: {} }),
    ),
  ).toMatchObject({
    image_base: "0x100000",
    segments: [
      { start: "0x101000", image_base: "0x100000", address_space: "ram" },
    ],
  });
});

it("keeps an unreported image base unknown instead of inventing zero or a segment start", async () => {
  const { image_base: _base, address_space: _space, ...unreported } = segment;
  const client = await overviewClient([unreported]);
  expect(
    jsonResult(
      await client.callTool({ name: "binary_overview", arguments: {} }),
    ),
  ).toMatchObject({ image_base: null });
});

it("preserves an explicitly observed zero image base", async () => {
  const client = await overviewClient([{ ...segment, image_base: "0x0" }]);
  expect(
    jsonResult(
      await client.callTool({ name: "binary_overview", arguments: {} }),
    ),
  ).toMatchObject({ image_base: "0x0" });
});

it("rejects conflicting provider image bases instead of choosing the first", async () => {
  const client = await overviewClient([
    segment,
    { ...segment, name: ".data", image_base: "0x200000" },
  ]);
  const result = await client.callTool({
    name: "binary_overview",
    arguments: {},
  });
  expect(result.isError).toBe(true);
  expect(parseMcpToolError(result).error.code).toBe("unreadable_output");
});
