export const ORCHESTRATOR_CEILING_PERCENT = 80;

export interface BudgetState {
  limitTokens: number;
  usedTokens: number;
  reservedTokens: number;
}

export function ceilingTokens(limitTokens: number): number {
  return Math.floor((limitTokens * ORCHESTRATOR_CEILING_PERCENT) / 100);
}

export function canReserve(state: BudgetState, requestedTokens: number): boolean {
  return (
    state.usedTokens + state.reservedTokens + requestedTokens <= ceilingTokens(state.limitTokens)
  );
}

export function reserve(state: BudgetState, requestedTokens: number): boolean {
  if (!canReserve(state, requestedTokens)) return false;
  state.reservedTokens += requestedTokens;
  return true;
}

export function settle(state: BudgetState, reservedTokens: number, usedTokens: number): void {
  state.reservedTokens = Math.max(0, state.reservedTokens - reservedTokens);
  state.usedTokens += Math.max(0, usedTokens);
}
