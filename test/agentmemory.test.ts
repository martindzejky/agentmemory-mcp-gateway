import { describe, expect, it } from "vitest";
import { readLimitedJson } from "../src/agentmemory.js";
import { UPSTREAM_INVALID } from "../src/errors.js";

const OVER_LIMIT = 2 * 1024 * 1024 + 1;

function streamBody(chunks: Uint8Array[], onPull?: () => void): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      onPull?.();
      const chunk = chunks[index];
      index += 1;
      if (!chunk) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

describe("readLimitedJson", () => {
  it("parses a small JSON body", async () => {
    const response = new Response(JSON.stringify({ tools: [] }), {
      headers: { "content-type": "application/json", "content-length": "12" },
    });
    await expect(readLimitedJson(response)).resolves.toEqual({ tools: [] });
  });

  it("rejects a declared content-length over the limit without reading the body", async () => {
    let pulled = 0;
    const response = new Response(
      streamBody([new Uint8Array(16)], () => {
        pulled += 1;
      }),
      { headers: { "content-length": String(OVER_LIMIT) } },
    );
    await expect(readLimitedJson(response)).rejects.toMatchObject({
      message: UPSTREAM_INVALID,
    });
    expect(pulled).toBe(0);
  });

  it("cancels an undeclared stream once the byte limit is exceeded", async () => {
    const big = new Uint8Array(OVER_LIMIT);
    big.fill(0x20);
    const response = new Response(streamBody([big, new TextEncoder().encode("{}")]));
    await expect(readLimitedJson(response)).rejects.toMatchObject({
      message: UPSTREAM_INVALID,
    });
  });
});
