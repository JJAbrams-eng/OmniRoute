import { randomUUID } from "node:crypto";
import { ceilingTokens, reserve, settle, type BudgetState } from "./budget";
import { createTask, updateTask, getTask } from "./store";
import type {
  AgentRun,
  ControllerStatus,
  CreateOrchestratorTask,
  OrchestratorAgent,
  OrchestratorTask,
} from "./types";
import { parseReview } from "./review";

const DEFAULT_MODELS = ["auto/coding", "auto/reasoning", "auto/cheap"];
const MAX_CONTEXT_CHARS = 12_000;
const MIN_REVIEW_RESERVATION = 128;
const MIN_AGENT_RESERVATION = 128;

function baseUrl(): string {
  return (
    process.env.OMNIROUTE_PUBLIC_BASE_URL?.replace(/\/$/, "") ||
    `http://127.0.0.1:${process.env.PORT || 20128}`
  );
}

function makeAgents(models: string[], providers?: Map<string, string>): OrchestratorAgent[] {
  return models.slice(0, 18).map((model, index) => ({
    id: `worker-${index + 1}`,
    model,
    provider: providers?.get(model),
    role: "worker",
    tokenLimit: Number(process.env.OMNIROUTE_ORCHESTRATOR_AGENT_LIMIT || 10_000),
    enabled: true,
  }));
}

async function defaultAgents(): Promise<OrchestratorAgent[]> {
  const configured = (process.env.OMNIROUTE_ORCHESTRATOR_MODELS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (configured.length) return makeAgents(configured);

  try {
    const { getUnifiedModelsResponse } = await import("@/app/api/v1/models/catalog");
    const response = await getUnifiedModelsResponse(new Request(`${baseUrl()}/v1/models`));
    if (response.ok) {
      const body = (await response.json()) as {
        data?: Array<{
          id?: string;
          owned_by?: string;
          type?: string;
          supported_endpoints?: string[];
        }>;
      };
      const providers = new Map<string, string>();
      const models = (body.data || [])
        .filter(
          (model) =>
            isChatCandidate(model) && typeof model.id === "string" && model.id && model.owned_by
        )
        .filter((model) => !model.id!.startsWith("auto/"))
        .map((model) => {
          providers.set(model.id!, model.owned_by!);
          return model.id!;
        });
      const uniqueModels = [...new Set(models)];
      const onePerProvider: string[] = [];
      const seenProviders = new Set<string>();
      for (const model of uniqueModels) {
        const provider = providers.get(model);
        if (!provider || seenProviders.has(provider)) continue;
        seenProviders.add(provider);
        onePerProvider.push(model);
        if (onePerProvider.length === 18) break;
      }
      if (onePerProvider.length) return makeAgents(onePerProvider, providers);
    }
  } catch (error) {
    console.warn(
      `[Orchestrator] model catalog discovery failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return makeAgents(DEFAULT_MODELS);
}

function isChatCandidate(model: {
  id?: string;
  owned_by?: string;
  type?: string;
  supported_endpoints?: string[];
}): boolean {
  const type = String(model.type || "chat").toLowerCase();
  if (["embedding", "image", "video", "audio", "rerank", "moderation"].includes(type)) return false;
  const provider = String(model.owned_by || "").toLowerCase();
  if (/(?:^|[-_])(web|aihorde)$/.test(provider) || provider.includes("veoaifree")) return false;
  if (Array.isArray(model.supported_endpoints) && model.supported_endpoints.length > 0) {
    const endpoints = model.supported_endpoints.map((endpoint) => endpoint.toLowerCase());
    if (!endpoints.some((endpoint) => endpoint.includes("chat") || endpoint.includes("responses")))
      return false;
  }
  return true;
}

function budgetKey(agent: Pick<OrchestratorAgent, "model" | "provider">): string {
  return `${agent.provider || "auto"}:${agent.model}`;
}

function reviewerCandidates(
  task: OrchestratorTask,
  agents: OrchestratorAgent[]
): OrchestratorAgent[] {
  const successfulWorkers = task.agents
    .filter((run) => run.agent.role === "worker" && run.state === "completed" && run.output?.trim())
    .map((run) => ({ ...run.agent, role: "reviewer" as const }));
  const candidates = [
    {
      id: "controller",
      model: task.reviewerModel,
      role: "reviewer" as const,
      tokenLimit: task.maxOutputTokens * 2,
      enabled: true,
    },
    ...successfulWorkers,
    ...agents
      .filter((agent) => agent.enabled)
      .map((agent) => ({ ...agent, role: "reviewer" as const })),
    ...DEFAULT_MODELS.map((model) => ({
      id: "controller",
      model,
      role: "reviewer" as const,
      tokenLimit: task.maxOutputTokens * 2,
      enabled: true,
    })),
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = budgetKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function predictedReviewTokens(task: OrchestratorTask): number {
  const recent = task.agents
    .filter(
      (run) => run.agent.role === "reviewer" && run.state === "completed" && run.usedTokens > 0
    )
    .slice(-3)
    .map((run) => run.usedTokens);
  if (recent.length === 0)
    return Math.max(MIN_REVIEW_RESERVATION, Math.min(task.maxOutputTokens * 2, 1024));
  return Math.max(MIN_REVIEW_RESERVATION, Math.ceil(Math.max(...recent) * 1.25));
}

function updateControllerStatus(
  task: OrchestratorTask,
  status: Omit<ControllerStatus, "updatedAt">
): void {
  updateTask(task.id, { controller: { ...status, updatedAt: new Date().toISOString() } });
}

function contentFromResponse(body: any): { text: string; tokens: number } {
  const choice = body?.choices?.[0];
  const text = choice?.message?.content ?? choice?.text ?? "";
  // `max_tokens` controls generated output, while `total_tokens` also includes
  // the controller's large review prompt. Budgeting by total_tokens would make
  // a healthy reviewer look exhausted before its output ceiling is reached.
  const usage = Number(
    body?.usage?.completion_tokens ?? body?.usage?.output_tokens ?? body?.usage?.total_tokens ?? 0
  );
  return {
    text: typeof text === "string" ? text : JSON.stringify(text),
    tokens: Number.isFinite(usage) ? usage : 0,
  };
}

async function callModel(
  model: string,
  prompt: string,
  maxTokens: number
): Promise<{ text: string; tokens: number }> {
  const response = await fetch(`${baseUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`model ${model} returned HTTP ${response.status}`);
  return contentFromResponse(body);
}

function buildReviewPrompt(original: string, outputs: AgentRun[]): string {
  const evidence = outputs
    .filter((run) => run.output)
    .map(
      (run) =>
        `### ${run.agent.id} (${run.agent.model})\n${run.output!.slice(0, MAX_CONTEXT_CHARS)}`
    )
    .join("\n\n");
  return `You are the controller/reviewer. Review the worker proposals below for the original task. Return strict JSON only: {"approved":boolean,"feedback":"...","finalAnswer":"...","confidence":0..1}. Approve only a complete, internally consistent solution. If not approved, feedback must be actionable for the next repair round.\n\nORIGINAL TASK:\n${original}\n\nWORKER PROPOSALS:\n${evidence}`;
}

async function runRound(
  task: OrchestratorTask,
  agents: OrchestratorAgent[],
  prompt: string,
  budgets: Map<string, BudgetState>
): Promise<void> {
  task.state = task.round === 0 ? "running" : "repairing";
  const runs: AgentRun[] = agents
    .filter((agent) => agent.enabled)
    .map((agent) => ({
      id: randomUUID(),
      agent,
      state: "queued",
      round: task.round,
      usedTokens: 0,
      reservedTokens: 0,
    }));
  task.agents = [...task.agents.filter((run) => run.round !== task.round), ...runs];
  updateTask(task.id, { state: task.state, agents: task.agents });

  await Promise.all(
    runs.map(async (run) => {
      const key = budgetKey(run.agent);
      const budget = budgets.get(key) ?? {
        limitTokens: run.agent.tokenLimit,
        usedTokens: 0,
        reservedTokens: 0,
      };
      budgets.set(key, budget);
      const requested = Math.min(
        task.maxOutputTokens,
        Math.max(0, ceilingTokens(run.agent.tokenLimit) - budget.usedTokens - budget.reservedTokens)
      );
      if (requested < MIN_AGENT_RESERVATION || !reserve(budget, requested)) {
        run.state = "blocked";
        run.error = "80% token ceiling reached";
        updateTask(task.id, { agents: task.agents });
        return;
      }
      run.reservedTokens = requested;
      run.state = "running";
      run.startedAt = new Date().toISOString();
      updateTask(task.id, { agents: task.agents });
      try {
        const result = await callModel(run.agent.model, prompt, requested);
        settle(budget, requested, result.tokens || requested);
        run.usedTokens = budget.usedTokens;
        run.reservedTokens = budget.reservedTokens;
        run.output = result.text.trim();
        run.state = run.output ? "completed" : "failed";
        if (!run.output) run.error = "Model returned an empty response";
      } catch (error) {
        settle(budget, requested, 0);
        run.reservedTokens = 0;
        run.state = "failed";
        run.error = error instanceof Error ? error.message : String(error);
      } finally {
        run.finishedAt = new Date().toISOString();
        updateTask(task.id, { agents: task.agents });
      }
    })
  );
}

export async function startOrchestrator(input: CreateOrchestratorTask): Promise<OrchestratorTask> {
  const agents = input.models?.length ? input.models : await defaultAgents();
  const reviewerModel =
    input.reviewerModel ||
    agents.find((agent) => agent.role === "reviewer")?.model ||
    "auto/reasoning";
  const task = createTask({
    prompt: input.prompt,
    state: "queued",
    round: 0,
    maxRounds: input.maxRounds,
    maxOutputTokens: input.maxOutputTokens,
    reviewerModel,
    agents: [],
    review: undefined,
    finalAnswer: undefined,
  });
  void execute(task.id, agents).catch((error) =>
    updateTask(task.id, {
      state: "failed",
      error: error instanceof Error ? error.message : String(error),
    })
  );
  return task;
}

async function execute(taskId: string, agents: OrchestratorAgent[]): Promise<void> {
  const task = getTask(taskId);
  if (!task) return;
  let prompt = task.prompt;
  const budgets = new Map<string, BudgetState>();
  for (let round = 0; round <= task.maxRounds; round++) {
    task.round = round;
    await runRound(task, agents, prompt, budgets);
    updateTask(task.id, { state: "reviewing", round: task.round, agents: task.agents });
    const predictedTokens = predictedReviewTokens(task);
    const reviewer = reviewerCandidates(task, agents)
      .map((candidate) => {
        const key = budgetKey(candidate);
        const budget = budgets.get(key) ?? {
          limitTokens: candidate.tokenLimit,
          usedTokens: 0,
          reservedTokens: 0,
        };
        budgets.set(key, budget);
        const remaining =
          ceilingTokens(budget.limitTokens) - budget.usedTokens - budget.reservedTokens;
        return { candidate, key, budget, remaining };
      })
      .find(({ remaining }) => remaining >= predictedTokens);
    if (!reviewer) {
      const fallback = reviewerCandidates(task, agents).find((candidate) => {
        const budget = budgets.get(budgetKey(candidate));
        return (
          budget &&
          ceilingTokens(budget.limitTokens) - budget.usedTokens - budget.reservedTokens >=
            MIN_REVIEW_RESERVATION
        );
      });
      updateControllerStatus(task, {
        forecast: "blocked",
        activeModel: task.reviewerModel,
        predictedTokens,
        remainingTokens: 0,
        ceilingTokens: task.maxOutputTokens * 2,
        nextModel: fallback?.model,
        nextProvider: fallback?.provider,
        message: fallback
          ? "Текущий reviewer исчерпан; подготовлена следующая модель."
          : "Свободного reviewer-бюджета не осталось.",
      });
      updateTask(task.id, {
        state: "failed",
        agents: task.agents,
        error: fallback
          ? "Reviewer forecast exceeded current model budget before safe switch"
          : "No reviewer model has enough forecast budget below its 80% ceiling",
      });
      return;
    }
    const nextCandidate = reviewerCandidates(task, agents).find(
      (candidate) =>
        candidate !== reviewer.candidate &&
        (budgets.get(budgetKey(candidate)) === undefined ||
          ceilingTokens(budgets.get(budgetKey(candidate))!.limitTokens) -
            budgets.get(budgetKey(candidate))!.usedTokens >=
            predictedTokens)
    );
    const remainingBeforeReserve = reviewer.remaining;
    updateControllerStatus(task, {
      forecast: remainingBeforeReserve < predictedTokens * 1.5 ? "warning" : "safe",
      activeModel: reviewer.candidate.model,
      activeProvider: reviewer.candidate.provider,
      nextModel: nextCandidate?.model,
      nextProvider: nextCandidate?.provider,
      predictedTokens,
      remainingTokens: remainingBeforeReserve,
      ceilingTokens: ceilingTokens(reviewer.budget.limitTokens),
      message: nextCandidate
        ? "Следующая reviewer-модель подготовлена заранее."
        : "Текущий reviewer имеет достаточный прогнозируемый бюджет.",
    });
    const reviewRun: AgentRun = {
      id: randomUUID(),
      agent: reviewer.candidate,
      state: "running",
      round,
      usedTokens: 0,
      reservedTokens: 0,
    };
    task.agents.push(reviewRun);
    updateTask(task.id, { agents: task.agents });
    const reviewerBudget = reviewer.budget;
    const controllerRequested = Math.min(
      task.maxOutputTokens * 2,
      Math.max(
        0,
        ceilingTokens(reviewerBudget.limitTokens) -
          reviewerBudget.usedTokens -
          reviewerBudget.reservedTokens
      )
    );
    if (
      controllerRequested < MIN_REVIEW_RESERVATION ||
      !reserve(reviewerBudget, controllerRequested)
    ) {
      reviewRun.state = "blocked";
      reviewRun.error = "Controller 80% token ceiling reached";
      updateTask(task.id, { state: "failed", agents: task.agents, error: reviewRun.error });
      return;
    }
    reviewRun.reservedTokens = controllerRequested;
    updateTask(task.id, { agents: task.agents });
    try {
      const result = await callModel(
        reviewer.candidate.model,
        buildReviewPrompt(
          task.prompt,
          task.agents.filter((run) => run.round === round && run.agent.role === "worker")
        ),
        controllerRequested
      );
      settle(reviewerBudget, controllerRequested, result.tokens || controllerRequested);
      reviewRun.reservedTokens = 0;
      reviewRun.usedTokens = result.tokens;
      reviewRun.state = "completed";
      reviewRun.output = result.text;
      const parsed = parseReview(result.text);
      task.review = {
        approved: parsed.approved === true,
        feedback: String(parsed.feedback || ""),
        confidence: Number(parsed.confidence) || undefined,
      };
      if (task.review.approved || round === task.maxRounds) {
        task.finalAnswer = String(
          parsed.finalAnswer || task.agents.find((run) => run.output)?.output || ""
        );
        updateTask(task.id, {
          state: task.review.approved ? "completed" : "failed",
          finalAnswer: task.finalAnswer,
          review: task.review,
          agents: task.agents,
        });
        return;
      }
      prompt = `${task.prompt}\n\nCONTROLLER FEEDBACK FROM ROUND ${round}:\n${task.review.feedback}\n\nRepair the solution and return only the improved result.`;
    } catch (error) {
      settle(reviewerBudget, controllerRequested, 0);
      reviewRun.reservedTokens = 0;
      reviewRun.state = "failed";
      reviewRun.error = error instanceof Error ? error.message : String(error);
      updateTask(task.id, { state: "failed", agents: task.agents, error: reviewRun.error });
      return;
    }
  }
}
