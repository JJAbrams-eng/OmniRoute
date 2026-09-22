import assert from "node:assert/strict";
import test from "node:test";
import { parseReview } from "../../src/lib/orchestrator/review";

test("review parser recovers duplicate-key provider JSON", () => {
  const review = parseReview(
    '{"approved":false,"feedback":"repair it","finalAnswer":"","confidence":相对来说,"confidence":1}'
  );
  assert.equal(review.approved, false);
  assert.equal(review.feedback, "repair it");
  assert.equal(review.confidence, 1);
});
