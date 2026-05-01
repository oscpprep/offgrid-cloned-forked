import { activeModelService } from './activeModelService';
import { localProvider } from './providers/localProvider';
import logger from '../utils/logger';
import type { ApiOperationStatus } from './localApiServerHelpers';

type ApiModelTarget = 'text' | 'image';
type ProgressCallback = (
  stage: string,
  message: string,
  details?: Record<string, unknown>,
) => ApiOperationStatus | null;

const LOAD_TIMEOUT_MS = 300000;
const MEMORY_SETTLE_MS = 750;
const LOW_HEADROOM_GB = 0.75;
const MEMORY_ERROR_PATTERNS = [
  'oom',
  'out of memory',
  'memory',
  'allocate',
  'allocation',
  'failed to load',
  'timed out',
];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMemoryLikeLoadError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return MEMORY_ERROR_PATTERNS.some(pattern => message.includes(pattern));
}

function shouldUnloadForApi(result: {
  severity: string;
  remainingAfterLoadGB: number;
}): boolean {
  return (
    result.severity === 'critical' ||
    result.remainingAfterLoadGB < LOW_HEADROOM_GB
  );
}

async function settleMemory(progress?: ProgressCallback): Promise<void> {
  progress?.(
    'memory_settle',
    'Waiting briefly for Android to reclaim model memory.',
  );
  await sleep(MEMORY_SETTLE_MS);
}

async function unloadOppositeModel(
  target: ApiModelTarget,
  progress?: ProgressCallback,
): Promise<boolean> {
  const loaded = activeModelService.getLoadedModelIds();
  if (target === 'text' && loaded.imageModelId) {
    progress?.(
      'unload_image',
      'Unloading the image model to free RAM for the text model.',
      {
        imageModelId: loaded.imageModelId,
      },
    );
    await activeModelService.unloadImageModel();
    await settleMemory(progress);
    return true;
  }

  if (target === 'image' && loaded.textModelId) {
    progress?.(
      'unload_text',
      'Unloading the text model to free RAM for the image model.',
      {
        textModelId: loaded.textModelId,
      },
    );
    await activeModelService.unloadTextModel();
    await settleMemory(progress);
    return true;
  }

  return false;
}

async function unloadIfDualModelUnsafe(
  target: ApiModelTarget,
  modelId: string,
  progress?: ProgressCallback,
): Promise<void> {
  const loaded = activeModelService.getLoadedModelIds();

  if (target === 'text' && loaded.imageModelId) {
    progress?.(
      'memory_check',
      'Checking if text and image models can remain loaded together.',
      {
        textModelId: modelId,
        imageModelId: loaded.imageModelId,
      },
    );
    const dual = await activeModelService.checkMemoryForDualModel(
      modelId,
      loaded.imageModelId,
    );
    if (shouldUnloadForApi(dual)) {
      progress?.('memory_handoff', dual.message, {
        severity: dual.severity,
        remainingAfterLoadGB: dual.remainingAfterLoadGB,
      });
      await unloadOppositeModel(target, progress);
    }
  }

  if (target === 'image' && loaded.textModelId) {
    progress?.(
      'memory_check',
      'Checking if image and text models can remain loaded together.',
      {
        textModelId: loaded.textModelId,
        imageModelId: modelId,
      },
    );
    const dual = await activeModelService.checkMemoryForDualModel(
      loaded.textModelId,
      modelId,
    );
    if (shouldUnloadForApi(dual)) {
      progress?.('memory_handoff', dual.message, {
        severity: dual.severity,
        remainingAfterLoadGB: dual.remainingAfterLoadGB,
      });
      await unloadOppositeModel(target, progress);
    }
  }
}

async function loadTargetModel(
  target: ApiModelTarget,
  modelId: string,
): Promise<void> {
  if (target === 'text') {
    await activeModelService.loadTextModel(modelId, LOAD_TIMEOUT_MS);
    return;
  }
  await activeModelService.loadImageModel(modelId, LOAD_TIMEOUT_MS);
}

export class ApiOperationTracker {
  private current: ApiOperationStatus | null = null;
  private last: ApiOperationStatus | null = null;

  start(params: {
    type: ApiOperationStatus['type'];
    requestId: string;
    modelId?: string;
    stage: string;
    message: string;
  }): ApiOperationStatus {
    const now = Date.now();
    this.current = {
      id: `op-${now}-${Math.random().toString(36).slice(2, 8)}`,
      type: params.type,
      requestId: params.requestId,
      modelId: params.modelId,
      stage: params.stage,
      message: params.message,
      startedAt: now,
      updatedAt: now,
    };
    logger.log('[LocalApiServer]', params.stage, params.message);
    return { ...this.current };
  }

  update(
    stage: string,
    message: string,
    details?: Record<string, unknown>,
  ): ApiOperationStatus | null {
    if (!this.current) return null;
    this.current = {
      ...this.current,
      stage,
      message,
      details,
      updatedAt: Date.now(),
    };
    logger.log('[LocalApiServer]', stage, message, details || '');
    return { ...this.current };
  }

  complete(message = 'Request completed.'): ApiOperationStatus | null {
    if (!this.current) return null;
    this.current = {
      ...this.current,
      stage: 'complete',
      message,
      complete: true,
      updatedAt: Date.now(),
    };
    this.last = { ...this.current };
    this.current = null;
    logger.log('[LocalApiServer] complete', message);
    return { ...this.last };
  }

  fail(message: string): ApiOperationStatus | null {
    if (!this.current) return null;
    this.current = {
      ...this.current,
      stage: 'error',
      message,
      error: message,
      complete: true,
      updatedAt: Date.now(),
    };
    this.last = { ...this.current };
    this.current = null;
    logger.warn('[LocalApiServer] error', message);
    return { ...this.last };
  }

  snapshot(): {
    current: ApiOperationStatus | null;
    last: ApiOperationStatus | null;
  } {
    return {
      current: this.current ? { ...this.current } : null,
      last: this.last ? { ...this.last } : null,
    };
  }
}

export async function ensureApiModelReady(params: {
  target: ApiModelTarget;
  modelId: string;
  unloadOther?: boolean;
  progress?: ProgressCallback;
}): Promise<void> {
  const { target, modelId, unloadOther = false, progress } = params;
  progress?.(
    'sync_native_state',
    'Syncing loaded model state before memory planning.',
  );
  await activeModelService.syncWithNativeState();

  if (unloadOther) {
    progress?.(
      'single_model_mode',
      `Single-model API mode is active; freeing RAM before loading ${target}.`,
      { modelId },
    );
    await unloadOppositeModel(target, progress);
  } else {
    await unloadIfDualModelUnsafe(target, modelId, progress);
  }

  try {
    progress?.('load_model', `Loading ${target} model for API request.`, {
      modelId,
    });
    await loadTargetModel(target, modelId);
  } catch (error) {
    if (!isMemoryLikeLoadError(error)) {
      throw error;
    }
    const unloaded = await unloadOppositeModel(target, progress);
    if (!unloaded) {
      throw error;
    }
    progress?.(
      'retry_load_model',
      `Retrying ${target} model load after freeing RAM.`,
      { modelId },
    );
    await loadTargetModel(target, modelId);
  }

  if (target === 'text') {
    progress?.(
      'provider_ready',
      'Binding the loaded text model to the OpenAI-compatible provider.',
      { modelId },
    );
    await localProvider.loadModel(modelId);
  }
}
