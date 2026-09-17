export type Category = 'visual' | 'reasoning' | 'text';
export type Protocol = 'chat-completions' | 'responses';
export interface Provider {
  id: string; name: string; baseUrl: string; protocol: Protocol;
  enabled: boolean; hasApiKey: boolean; createdAt: string;
  retentionDays?: number | null; apiKeyPreview?: string;
}
export interface Model {
  id: string; providerId: string; name: string; modelId: string;
  enabled: boolean; maxTokens: number;
  reasoningEffort: string; createdAt: string;
}
export interface Prompt {
  id: string; title: string; description: string; category: Category;
  content: string; referenceAnswer: string; rubric: string; tags: string[];
  enabled: boolean; createdAt: string; updatedAt: string;
}
export interface Run {
  id: string; batchId: string; promptId: string; modelId: string;
  providerName: string; modelName: string; modelSlug: string;
  promptTitle: string; promptContent: string; category: Category;
  referenceAnswer: string; rubric: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  source: 'api' | 'sample'; sourceLabel: string;
  output: string; html: string; reasoning: string; error: string;
  latencyMs: number | null; inputTokens: number | null; outputTokens: number | null;
  createdAt: string; finishedAt: string | null;
  /** Public presentation metadata derived from the original invocation, including retry history. */
  batchCreatedAt?: string;
  parameters: { protocol?: Protocol; maxTokens?: number; reasoningEffort?: string };
  providerId?: string; scheduleId?: string;
  artifactAvailable?: boolean; artifactExpiresAt?: string | null;
  artifactStorage?: 'memory' | 'disk' | 's3' | 'cloudflare';
  hasHtml?: boolean; cleanupError?: string;
  retryLimit?: number; retryAttempt?: number; retryRootId?: string;
  retryOf?: string; retryKind?: 'automatic' | 'manual'; nextRetryId?: string; retryAt?: string;
  /** Per-attempt timeout captured when this invocation is created. */
  requestTimeoutSeconds?: number;
}
export interface PublicProvider { id: string; name: string }
export interface PublicModel { id: string; name: string; providerName: string; providerId: string }
export interface DiscoveredModel { id: string; ownedBy?: string }
export interface PublicData {
  providers: PublicProvider[];
  prompts: Prompt[]; models: PublicModel[]; runs: Run[];
  stats: { apiRuns: number; sampleRuns: number; modelCount: number; promptCount: number };
}
export interface Schedule {
  id: string; name: string; promptIds: string[]; modelIds: string[];
  intervalMinutes: number; enabled: boolean;
  scheduleType?: 'interval' | 'cron'; cronExpression?: string; timezone?: string;
  lastRunAt: string | null; nextRunAt: string; lastError: string; createdAt: string;
}
export interface LabSettings { retentionDays: number; maxRetries?: number; requestTimeoutSeconds?: number }
export interface StorageSettings {
  mode: 'memory' | 'disk' | 's3' | 'cloudflare'; endpoint: string; region: string; bucket: string; prefix: string;
  backend?: 'r2' | 'durable-sqlite';
  hasAccessKeyId: boolean; hasSecretAccessKey: boolean;
  memoryLimitMb: number; memoryUsedMb: number;
}
export interface AdminData {
  providers: Provider[]; models: Model[]; prompts: Prompt[]; runs: Run[];
  schedules: Schedule[]; settings: LabSettings; storage: StorageSettings;
}
