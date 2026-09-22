import { z } from "zod";

export const OrchestratorTaskState = {
  queued: "queued",
  running: "running",
  reviewing: "reviewing",
  repairing: "repairing",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

export type OrchestratorTaskState =
  (typeof OrchestratorTaskState)[keyof typeof OrchestratorTaskState];

export const AgentRole = {
  worker: "worker",
  reviewer: "reviewer",
  controller: "controller",
} as const;

export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

export const OrchestratorAgentSchema = z.object({
  id: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  provider: z.string().max(100).optional(),
  role: z.enum(["worker", "reviewer", "controller"]).default("worker"),
  tokenLimit: z.number().int().positive().max(1_000_000).default(10_000),
  enabled: z.boolean().default(true),
});

export type OrchestratorAgent = z.infer<typeof OrchestratorAgentSchema>;

export const CreateOrchestratorTaskSchema = z.object({
  prompt: z.string().min(1).max(50_000),
  models: z.array(OrchestratorAgentSchema).min(1).max(18).optional(),
  reviewerModel: z.string().min(1).max(200).optional(),
  maxRounds: z.number().int().min(0).max(5).default(2),
  maxOutputTokens: z.number().int().min(128).max(16_000).default(2_000),
});

export type CreateOrchestratorTask = z.infer<typeof CreateOrchestratorTaskSchema>;

export interface AgentRun {
  id: string;
  agent: OrchestratorAgent;
  state: "queued" | "running" | "completed" | "failed" | "blocked";
  round: number;
  startedAt?: string;
  finishedAt?: string;
  usedTokens: number;
  reservedTokens: number;
  output?: string;
  error?: string;
}

export interface ControllerStatus {
  activeModel?: string;
  activeProvider?: string;
  nextModel?: string;
  nextProvider?: string;
  forecast: "safe" | "warning" | "switching" | "blocked";
  predictedTokens: number;
  remainingTokens: number;
  ceilingTokens: number;
  message: string;
  updatedAt: string;
}

export interface OrchestratorTask {
  id: string;
  prompt: string;
  state: OrchestratorTaskState;
  round: number;
  maxRounds: number;
  maxOutputTokens: number;
  reviewerModel: string;
  agents: AgentRun[];
  controller?: ControllerStatus;
  review?: { approved: boolean; feedback: string; confidence?: number };
  finalAnswer?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface OrchestratorSnapshot {
  task: OrchestratorTask;
  ceilingPercent: 80;
}
