"use client";

import { useEffect, useMemo, useState } from "react";

type Agent = {
  id: string;
  model: string;
  role: string;
  state: string;
  round: number;
  usedTokens: number;
  reservedTokens: number;
  agent: { id: string; model: string; tokenLimit: number; provider?: string };
};
type Task = {
  id: string;
  state: string;
  round: number;
  maxRounds: number;
  prompt: string;
  createdAt?: string;
  updatedAt?: string;
  agents: Agent[];
  controller?: {
    activeModel?: string;
    activeProvider?: string;
    nextModel?: string;
    nextProvider?: string;
    forecast: string;
    predictedTokens: number;
    remainingTokens: number;
    ceilingTokens: number;
    message: string;
  };
  review?: { approved: boolean; feedback: string; confidence?: number };
  finalAnswer?: string;
  error?: string;
};
type ProviderLimit = {
  connectionId: string;
  provider: string;
  label: string;
  remainingPercent: number | null;
  quotaCount: number;
  fetchedAt: string | null;
  source: string | null;
  status: "known" | "unknown";
};

export default function OrchestratorPage() {
  const [prompt, setPrompt] = useState("");
  const [task, setTask] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [limitsError, setLimitsError] = useState("");
  const [providerLimits, setProviderLimits] = useState<ProviderLimit[]>([]);
  const [history, setHistory] = useState<Task[]>([]);
  const activeAgents = useMemo(() => task?.agents ?? [], [task]);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const response = await fetch("/api/orchestrator/limits", { cache: "no-store" });
      if (!response.ok) {
        if (mounted) setLimitsError(`Provider limits: HTTP ${response.status}`);
        return;
      }
      const body = await response.json();
      if (mounted) {
        setProviderLimits(body.limits || []);
        setLimitsError("");
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const loadHistory = async () => {
      const response = await fetch("/api/orchestrator/tasks", { cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json();
      setHistory(body.history || []);
    };
    void loadHistory();
  }, []);

  useEffect(() => {
    if (!task?.id) return;
    const source = new EventSource(`/api/orchestrator/tasks/${task.id}/events`);
    source.addEventListener("snapshot", (event) =>
      setTask(JSON.parse((event as MessageEvent).data).task)
    );
    source.onerror = () => undefined;
    return () => source.close();
  }, [task?.id]);

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/orchestrator/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, maxRounds: 2, maxOutputTokens: 2000 }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          body.error?.formErrors?.join(", ") || body.error || "Не удалось запустить задачу"
        );
      setTask(body.task);
      setHistory((current) =>
        [body.task, ...current.filter((item: Task) => item.id !== body.task.id)].slice(0, 30)
      );
      setPrompt("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Agent Orchestrator</h1>
        <p className="text-sm text-text-muted">
          Параллельные workers → controller/reviewer → repair rounds. Лимит каждого агента: максимум
          80%.
        </p>
      </div>
      <section className="rounded-xl border border-border bg-surface p-4 space-y-3">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Опишите задачу для агентной команды…"
          className="min-h-32 w-full rounded-lg border border-border bg-background p-3"
        />
        <button
          disabled={!prompt.trim() || busy}
          onClick={submit}
          className="rounded-lg bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Запуск…" : "Запустить команду"}
        </button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </section>
      {limitsError && (
        <p className="text-sm text-amber-400">{limitsError}. Проверьте авторизацию dashboard.</p>
      )}
      {history.length > 0 && (
        <section className="rounded-xl border border-border bg-surface p-4">
          <h2 className="font-medium">История задач</h2>
          <div className="mt-3 space-y-2">
            {history.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setPrompt(item.prompt)}
                className="block w-full rounded-lg border border-border p-3 text-left hover:bg-background"
              >
                <div className="flex justify-between text-xs text-text-muted">
                  <span>
                    {item.state} · round {item.round}/{item.maxRounds}
                  </span>
                  <span>{new Date(item.updatedAt || item.createdAt).toLocaleString()}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm">{item.prompt}</p>
              </button>
            ))}
          </div>
        </section>
      )}
      {providerLimits.length > 0 && (
        <section className="rounded-xl border border-border bg-surface p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Provider capacity</h2>
            <span className="text-xs text-text-muted">обновление каждые 5 сек · стоп на 80%</span>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2 lg:grid-cols-3">
            {providerLimits.map((limit) => {
              const remaining = limit.remainingPercent;
              const available = remaining === null ? null : Math.max(0, Math.min(100, remaining));
              return (
                <div key={limit.connectionId} className="rounded-lg border border-border p-3">
                  <div className="flex justify-between text-sm">
                    <span className="truncate">{limit.label}</span>
                    <span className="ml-2 text-text-muted">{limit.provider}</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded bg-background">
                    <div
                      className={`h-full ${available !== null && available <= 20 ? "bg-red-500" : available !== null && available <= 40 ? "bg-amber-500" : "bg-emerald-500"}`}
                      style={{ width: `${available === null ? 0 : available}%` }}
                    />
                  </div>
                  <div className="mt-1 flex justify-between text-xs text-text-muted">
                    <span>
                      {available === null
                        ? "лимит не синхронизирован"
                        : `${Math.round(available)}% осталось`}
                    </span>
                    <span>{limit.quotaCount ? `${limit.quotaCount} квот` : "нет данных"}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
      {task && (
        <>
          <section className="rounded-xl border border-border bg-surface p-4">
            <div className="flex justify-between">
              <h2 className="font-medium">Задача {task.id.slice(0, 8)}</h2>
              <span>
                {task.state} · round {task.round}/{task.maxRounds}
              </span>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {activeAgents.map((run) => {
                const ceiling = Math.floor(run.agent.tokenLimit * 0.8);
                const used = run.usedTokens + run.reservedTokens;
                const percent = Math.min(100, Math.round((used / Math.max(1, ceiling)) * 100));
                return (
                  <div key={run.id} className="rounded-lg border border-border p-3">
                    <div className="flex justify-between text-sm">
                      <span>{run.agent.id}</span>
                      <span>{run.state}</span>
                    </div>
                    <div className="mt-1 text-xs text-text-muted">
                      {run.agent.provider || "OmniRoute"} · {run.agent.model}
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded bg-background">
                      <div
                        className={`h-full ${percent >= 100 ? "bg-red-500" : percent >= 80 ? "bg-amber-500" : "bg-emerald-500"}`}
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                    <div className="mt-1 flex justify-between text-xs text-text-muted">
                      <span>
                        {used.toLocaleString()} / {ceiling.toLocaleString()} tokens
                      </span>
                      <span>{percent}% ceiling</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
          {task.controller && (
            <section className="rounded-xl border border-border bg-surface p-4">
              <div className="flex items-center justify-between">
                <h2 className="font-medium">Controller budget sentinel</h2>
                <span
                  className={`text-xs ${task.controller.forecast === "switching" ? "text-amber-400" : task.controller.forecast === "blocked" ? "text-red-400" : "text-emerald-400"}`}
                >
                  {task.controller.forecast}
                </span>
              </div>
              <p className="mt-2 text-sm text-text-muted">{task.controller.message}</p>
              <div className="mt-2 text-xs text-text-muted">
                Текущая: {task.controller.activeProvider || "OmniRoute"} ·{" "}
                {task.controller.activeModel || "—"} · прогноз следующей проверки:{" "}
                {task.controller.predictedTokens.toLocaleString()} токенов · осталось:{" "}
                {task.controller.remainingTokens.toLocaleString()} /{" "}
                {task.controller.ceilingTokens.toLocaleString()}
              </div>
              {task.controller.nextModel && (
                <div className="mt-1 text-xs text-amber-400">
                  Подготовлена следующая: {task.controller.nextProvider || "OmniRoute"} ·{" "}
                  {task.controller.nextModel}
                </div>
              )}
            </section>
          )}
          {task.review && (
            <section className="rounded-xl border border-border bg-surface p-4">
              <h2 className="font-medium">
                Controller review: {task.review.approved ? "approved" : "needs repair"}
              </h2>
              <p className="mt-2 whitespace-pre-wrap text-sm text-text-muted">
                {task.review.feedback}
              </p>
            </section>
          )}
          {task.error && (
            <section className="rounded-xl border border-red-500/30 bg-surface p-4">
              <h2 className="font-medium text-red-400">Ошибка выполнения</h2>
              <p className="mt-2 whitespace-pre-wrap text-sm">{task.error}</p>
            </section>
          )}
          {task.finalAnswer && (
            <section className="rounded-xl border border-emerald-500/30 bg-surface p-4">
              <h2 className="font-medium">Финальный результат</h2>
              <pre className="mt-3 whitespace-pre-wrap text-sm">{task.finalAnswer}</pre>
            </section>
          )}
        </>
      )}
    </main>
  );
}
