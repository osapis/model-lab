import type { Model, Prompt, Schedule, SchedulePair } from './types.ts';

export function uniqueSchedulePairs(pairs: readonly SchedulePair[]): SchedulePair[] {
  const seen = new Set<string>();
  return pairs.filter(pair => {
    const key = `${pair.promptId}\u0000${pair.modelId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(pair => ({ promptId: pair.promptId, modelId: pair.modelId }));
}

/** Resolve each round against current switches without changing the saved selection. */
export function resolveScheduleSelection<P extends { id: string; enabled: boolean }>(
  schedule: Pick<Schedule, 'promptIds' | 'modelIds' | 'promptModelPairs'>,
  prompts: readonly Prompt[],
  models: readonly Model[],
  providers: readonly P[],
) {
  const explicitPairs = schedule.promptModelPairs !== undefined;
  const selectedPairs = explicitPairs ? uniqueSchedulePairs(schedule.promptModelPairs || []) : undefined;
  const promptIds = explicitPairs
    ? [...new Set(selectedPairs!.map(pair => pair.promptId))]
    : [...new Set(schedule.promptIds)];
  const modelIds = explicitPairs
    ? [...new Set(selectedPairs!.map(pair => pair.modelId))]
    : [...new Set(schedule.modelIds)];
  const promptMap = new Map(prompts.map(prompt => [prompt.id, prompt]));
  const modelMap = new Map(models.map(model => [model.id, model]));
  const providerMap = new Map(providers.map(provider => [provider.id, provider]));
  const eligiblePrompts = promptIds.flatMap(id => {
    const prompt = promptMap.get(id);
    return prompt?.enabled ? [prompt] : [];
  });
  const modelsWithProviders = modelIds.flatMap(id => {
    const model = modelMap.get(id);
    const provider = model && providerMap.get(model.providerId);
    return model?.enabled && provider?.enabled ? [{ model, provider }] : [];
  });
  const promptMapEnabled = new Map(eligiblePrompts.map(prompt => [prompt.id, prompt]));
  const modelPairMap = new Map(modelsWithProviders.map(pair => [pair.model.id, pair]));
  const pairs = explicitPairs
    ? selectedPairs!.flatMap(pair => {
      const prompt = promptMapEnabled.get(pair.promptId);
      const model = modelPairMap.get(pair.modelId);
      return prompt && model ? [{ prompt, model: model.model, provider: model.provider }] : [];
    })
    : modelsWithProviders.flatMap(({ model, provider }) => eligiblePrompts.map(prompt => ({ prompt, model, provider })));
  return {
    prompts: eligiblePrompts,
    models: modelsWithProviders.map(pair => pair.model),
    pairs,
    selectedPromptCount: promptIds.length,
    selectedModelCount: modelIds.length,
    skippedPromptCount: promptIds.length - eligiblePrompts.length,
    skippedModelCount: modelIds.length - modelsWithProviders.length,
    runnableCount: pairs.length,
  };
}
