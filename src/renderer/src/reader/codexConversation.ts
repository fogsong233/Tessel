import type { CodexModelInfo } from '../../../shared/domain';

export type CodexModelCommandResult =
  | { kind: 'open' }
  | { kind: 'update'; model?: string; effort?: string; modelLabel?: string }
  | { kind: 'unknown-model'; value: string }
  | { kind: 'unsupported-effort'; value: string };

const effortAliases: Record<string, string> = {
  none: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'ultra',
  '无': 'none',
  '极低': 'minimal',
  '低': 'low',
  '中': 'medium',
  '高': 'high',
  '极高': 'xhigh',
  '最大': 'max',
  '极限': 'ultra'
};

let cachedModels: CodexModelInfo[] | undefined;
let pendingModels: Promise<CodexModelInfo[]> | undefined;

export function loadCodexModels(): Promise<CodexModelInfo[]> {
  if (cachedModels) {
    return Promise.resolve(cachedModels);
  }
  if (!pendingModels) {
    pendingModels = window.sidelight.listCodexModels()
      .then((models) => {
        cachedModels = models;
        return models;
      })
      .finally(() => {
        pendingModels = undefined;
      });
  }
  return pendingModels;
}

export function resolveCodexModelCommand(
  argument: string,
  models: CodexModelInfo[],
  currentModel?: string
): CodexModelCommandResult {
  const normalizedArgument = argument.trim().replace(/\s+/g, ' ');
  if (!normalizedArgument) {
    return { kind: 'open' };
  }

  const tokens = normalizedArgument.split(' ');
  const requestedEffort = normalizeReasoningEffort(tokens.at(-1) ?? '');
  if (requestedEffort && tokens.length === 1) {
    const selected = findModel(models, currentModel ?? '');
    if (selected && !supportsEffort(selected, requestedEffort)) {
      return { kind: 'unsupported-effort', value: requestedEffort };
    }
    return {
      kind: 'update',
      ...(currentModel ? { model: currentModel } : {}),
      effort: requestedEffort,
      modelLabel: selected?.displayName ?? currentModel
    };
  }

  const modelQuery = requestedEffort ? tokens.slice(0, -1).join(' ') : normalizedArgument;
  if (/^(?:default|reader-default|默认)$/i.test(modelQuery)) {
    return requestedEffort
      ? { kind: 'update', effort: requestedEffort }
      : { kind: 'update' };
  }

  const selected = findModel(models, modelQuery);
  if (!selected) {
    // The CLI model cache can be briefly unavailable during first launch. An
    // explicit model id is still safe to persist and will be validated by Codex.
    if (models.length === 0 && /^[a-z0-9][a-z0-9._:-]{1,80}$/i.test(modelQuery)) {
      return {
        kind: 'update',
        model: modelQuery,
        ...(requestedEffort ? { effort: requestedEffort } : {}),
        modelLabel: modelQuery
      };
    }
    return { kind: 'unknown-model', value: modelQuery };
  }
  if (requestedEffort && !supportsEffort(selected, requestedEffort)) {
    return { kind: 'unsupported-effort', value: requestedEffort };
  }
  return {
    kind: 'update',
    model: selected.id,
    ...(requestedEffort ? { effort: requestedEffort } : {}),
    modelLabel: selected.displayName
  };
}

function normalizeReasoningEffort(value: string): string | undefined {
  return effortAliases[value.trim().toLocaleLowerCase()];
}

function findModel(models: CodexModelInfo[], query: string): CodexModelInfo | undefined {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) {
    return undefined;
  }
  const exact = models.find((model) =>
    model.id.toLocaleLowerCase() === normalized || model.displayName.toLocaleLowerCase() === normalized
  );
  if (exact) {
    return exact;
  }
  const prefixMatches = models.filter((model) =>
    model.id.toLocaleLowerCase().startsWith(normalized) || model.displayName.toLocaleLowerCase().startsWith(normalized)
  );
  return prefixMatches.length === 1 ? prefixMatches[0] : undefined;
}

function supportsEffort(model: CodexModelInfo, effort: string): boolean {
  return model.supportedReasoningEfforts.length === 0 || model.supportedReasoningEfforts.includes(effort);
}
