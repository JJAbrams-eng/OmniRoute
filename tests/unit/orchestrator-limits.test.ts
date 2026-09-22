import assert from "node:assert/strict";
import test from "node:test";
import { calculateRemainingPercent } from "../../src/lib/orchestrator/limits";

test("provider quota telemetry calculates remaining percentage conservatively", () => {
  assert.equal(calculateRemainingPercent({ total: 100, used: 25 }), 75);
  assert.equal(calculateRemainingPercent({ remainingPercentage: 14 }), 14);
  assert.equal(calculateRemainingPercent({ unlimited: true }), 100);
  assert.equal(calculateRemainingPercent({}), null);
});
