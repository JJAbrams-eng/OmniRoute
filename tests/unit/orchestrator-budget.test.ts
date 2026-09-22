import assert from "node:assert/strict";
import test from "node:test";
import { canReserve, ceilingTokens, reserve, settle } from "../../src/lib/orchestrator/budget.ts";

test("orchestrator never reserves above the 80 percent ceiling", () => {
  const state = { limitTokens: 1000, usedTokens: 0, reservedTokens: 0 };
  assert.equal(ceilingTokens(state.limitTokens), 800);
  assert.equal(reserve(state, 800), true);
  assert.equal(canReserve(state, 1), false);
  assert.equal(reserve(state, 1), false);
});

test("settlement releases reservation and records actual usage", () => {
  const state = { limitTokens: 1000, usedTokens: 0, reservedTokens: 800 };
  settle(state, 800, 311);
  assert.deepEqual(state, { limitTokens: 1000, usedTokens: 311, reservedTokens: 0 });
});
