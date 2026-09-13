import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * GLM's translateSseResponse used to pass a 16th positional (a bare 65536
 * literal) to createSSETransformStreamWithLogger back when the helper only
 * had 15 parameters (last was requestToolIdentityMap) — tsc reported TS2554
 * and the number never reached TransformStream.
 *
 * The helper has since grown a legitimate 16th parameter, streamBufferBytes
 * (open-sse/utils/stream.ts), and GLM now passes its own named
 * GLM_STREAM_BUFFER_BYTES constant there — that is intentional, not a
 * regression. Guard the call site in source for the original failure mode
 * instead: no *raw numeric literal* positional after suppressThinkClose
 * (only named identifiers/undefined are allowed there).
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function extractParens(src: string, openAt: number): string {
  let i = openAt + 1;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    i += 1;
  }
  return src.slice(openAt, i);
}

test("createSSETransformStreamWithLogger has no highWaterMark slot", () => {
  const src = readFileSync(join(root, "open-sse", "utils", "stream.ts"), "utf8");
  const needle = "export function createSSETransformStreamWithLogger(";
  const start = src.indexOf(needle);
  assert.ok(start >= 0);
  const header = extractParens(src, start + needle.length - 1);
  assert.equal(/highWaterMark/.test(header), false, header);
  assert.match(header, /requestToolIdentityMap/);
  assert.match(header, /suppressThinkClose/);
});

test("GLM translateSseResponse does not pass a 16th positional to the stream helper", () => {
  const src = readFileSync(join(root, "open-sse", "executors", "glm.ts"), "utf8");
  const fnStart = src.indexOf("export function translateSseResponse(");
  assert.ok(fnStart >= 0);
  const fnEnd = src.indexOf("\nexport class GlmExecutor", fnStart);
  const body = src.slice(fnStart, fnEnd);
  const callAt = body.indexOf("createSSETransformStreamWithLogger(");
  assert.ok(callAt >= 0);
  const call = extractParens(body, callAt + "createSSETransformStreamWithLogger".length);
  const afterSuppressThinkClose = call.slice(call.indexOf("suppressThinkClose"));
  assert.doesNotMatch(
    afterSuppressThinkClose,
    /,\s*\d+\s*[,)]/,
    `raw numeric literal positional after suppressThinkClose (dead-arg regression):\n${call}`
  );
});
