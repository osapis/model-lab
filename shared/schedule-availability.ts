import type { Model, Prompt, Schedule } from './types.ts';

/** Resolve each round against current switches without changing the saved selection. */
export function resolveScheduleSelection<P extends { id: string; enabled: boolean }>(
  schedule: Pick<Schedule, 'promptIds' | 'modelIds'>,
  prompts: readonly Prompt[],
  models: readonly Model[],
  providers: readonly P[],
) {
  const promptIds = [...new Set(schedule.promptIds)];
  const modelIds = [...new Set(schedule.modelIds)];
  const promptMap = new Map(prompts.map(prompt => [prompt.id, prompt]));
  const modelMap = new Map(models.map(model => [model.id, model]));
  const providerMap = new Map(providers.map(provider => [provider.id, provider]));
  const eligiblePrompts = promptIds.flatMap(id => {
    const prompt = promptMap.get(id);
    return prompt?.enabled ? [prompt] : [];
  });
  const pairs = modelIds.flatMap(id => {
    const model = modelMap.get(id);
    const provider = model && providerMap.get(model.providerId);
    return model?.enabled && provider?.enabled ? [{ model, provider }] : [];
  });
  return {
    prompts: eligiblePrompts,
    models: pairs.map(pair => pair.model),
    pairs,
    selectedPromptCount: promptIds.length,
    selectedModelCount: modelIds.length,
    skippedPromptCount: promptIds.length - eligiblePrompts.length,
    skippedModelCount: modelIds.length - pairs.length,
    runnableCount: eligiblePrompts.length * pairs.length,
  };
}
