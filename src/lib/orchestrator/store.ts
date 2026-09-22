import { randomUUID } from "node:crypto";
import { emit } from "@/lib/events/eventBus";
import { getDbInstance, isBuildPhase } from "@/lib/db/core";
import type { OrchestratorSnapshot, OrchestratorTask } from "./types";

const TASK_NAMESPACE = "orchestratorTasks";

declare global {
  var __omnirouteOrchestrator:
    { tasks: Map<string, OrchestratorTask>; subscribers: Map<string, Set<() => void>> } | undefined;
}

function state() {
  if (!globalThis.__omnirouteOrchestrator) {
    globalThis.__omnirouteOrchestrator = { tasks: new Map(), subscribers: new Map() };
  }
  return globalThis.__omnirouteOrchestrator;
}

function persist(task: OrchestratorTask): void {
  if (isBuildPhase) return;
  try {
    getDbInstance()
      .prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
      .run(TASK_NAMESPACE, task.id, JSON.stringify(task));
  } catch (error) {
    console.warn(
      `[Orchestrator] task persistence failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function load(id: string): OrchestratorTask | undefined {
  if (isBuildPhase) return undefined;
  try {
    const row = getDbInstance()
      .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
      .get(TASK_NAMESPACE, id) as { value?: string } | undefined;
    if (!row?.value) return undefined;
    const task = JSON.parse(row.value) as OrchestratorTask;
    if (!task || task.id !== id || typeof task.prompt !== "string") return undefined;
    state().tasks.set(id, task);
    return task;
  } catch {
    return undefined;
  }
}

export function createTask(
  input: Omit<OrchestratorTask, "id" | "createdAt" | "updatedAt">
): OrchestratorTask {
  const now = new Date().toISOString();
  const task = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
  state().tasks.set(task.id, task);
  persist(task);
  notify(task);
  return task;
}

export function getTask(id: string): OrchestratorTask | undefined {
  return state().tasks.get(id) ?? load(id);
}

export function listTasks(limit = 30): OrchestratorTask[] {
  const tasks = new Map(state().tasks);
  if (!isBuildPhase) {
    try {
      const rows = getDbInstance()
        .prepare("SELECT value FROM key_value WHERE namespace = ? ORDER BY rowid DESC LIMIT ?")
        .all(TASK_NAMESPACE, limit) as Array<{ value?: string }>;
      for (const row of rows) {
        if (!row.value) continue;
        try {
          const task = JSON.parse(row.value) as OrchestratorTask;
          if (task?.id && typeof task.prompt === "string") tasks.set(task.id, task);
        } catch {
          // Ignore one corrupt history record without hiding healthy tasks.
        }
      }
    } catch {
      // In-memory tasks remain available if the database is temporarily busy.
    }
  }
  return [...tasks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
}

export function updateTask(id: string, update: Partial<OrchestratorTask>): OrchestratorTask {
  const task = state().tasks.get(id);
  if (!task) throw new Error("Orchestrator task not found");
  Object.assign(task, update, { updatedAt: new Date().toISOString() });
  persist(task);
  notify(task);
  return task;
}

export function subscribeTask(id: string, listener: () => void): () => void {
  const subscribers = state().subscribers.get(id) ?? new Set<() => void>();
  subscribers.add(listener);
  state().subscribers.set(id, subscribers);
  return () => subscribers.delete(listener);
}

export function snapshot(task: OrchestratorTask): OrchestratorSnapshot {
  return { task: structuredClone(task), ceilingPercent: 80 };
}

function notify(task: OrchestratorTask): void {
  try {
    emit("agent.task.updated", {
      source: "a2a",
      taskId: task.id,
      state: task.state,
      timestamp: Date.now(),
    });
  } catch {
    // Live updates are best effort and must never break task state writes.
  }
  for (const listener of state().subscribers.get(task.id) ?? []) {
    try {
      listener();
    } catch {
      /* subscriber isolation */
    }
  }
}
