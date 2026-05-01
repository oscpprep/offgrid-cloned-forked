/* istanbul ignore file */
/* eslint-disable max-lines, complexity */
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import DeviceInfo from 'react-native-device-info';
import RNFS from 'react-native-fs';
import { activeModelService } from './activeModelService';
import { generationService } from './generationService';
import { imageGenerationService } from './imageGenerationService';
import { llmService } from './llm';
import { localDreamGeneratorService } from './localDreamGenerator';
import { modelManager } from './modelManager';
import { useAppStore } from '../stores';
import logger from '../utils/logger';
import {
  runLocalCompletion,
  streamLocalChatCompletion,
} from './localApiServerChat';
import {
  ApiOperationTracker,
  ensureApiModelReady,
} from './localApiServerRuntime';
import {
  ApiRequestError,
  buildActionResponse,
  buildCapabilitiesResponse,
  buildChatCompletionResponse,
  buildErrorResponse,
  buildImageGenerationResponse,
  buildModelsResponse,
  buildStatusResponse,
  buildUnloadResponse,
  getDefaultImageModelId,
  getDefaultTextModelId,
  normalizeApiError,
  parseCacheClearRequest,
  parseChatRequest,
  parseDownloadCancelRequest,
  parseGalleryDeleteRequest,
  parseImageRequest,
  parseModelControlRequest,
  parseSettingsPatchRequest,
  parseStopRequest,
  parseUnloadRequest,
  type ApiControlTarget,
  type ApiOperationStatus,
  type NativeApiRequest,
} from './localApiServerHelpers';

type NativeStatus = {
  isRunning: boolean;
  port: number;
  listenerReady: boolean;
};

type LocalApiNativeModule = {
  startServer: (config: {
    port: number;
    apiKey: string;
  }) => Promise<NativeStatus>;
  stopServer: () => Promise<NativeStatus>;
  getStatus: () => Promise<NativeStatus>;
  respondJson: (
    requestId: string,
    statusCode: number,
    body: string,
    headers?: Record<string, string> | null,
  ) => Promise<boolean>;
  startStream: (
    requestId: string,
    statusCode: number,
    headers?: Record<string, string> | null,
  ) => Promise<boolean>;
  streamChunk: (requestId: string, chunk: string) => Promise<boolean>;
  finishStream: (requestId: string) => Promise<boolean>;
  failRequest: (
    requestId: string,
    statusCode: number,
    message: string,
  ) => Promise<boolean>;
  addListener: (eventName: string) => void;
  removeListeners: (count: number) => void;
};

const { LocalApiServerModule } = NativeModules as {
  LocalApiServerModule?: LocalApiNativeModule;
};

export type LocalApiServerStatus = {
  isRunning: boolean;
  port: number;
  endpoint: string | null;
  lanEndpoint: string | null;
  loopbackEndpoint: string | null;
  localhostEndpoint: string | null;
  listenerReady: boolean;
  lastError: string | null;
};

type StatusListener = (status: LocalApiServerStatus) => void;

function formatHostForUrl(ip: string): string {
  return ip.includes(':') && !ip.startsWith('[') ? `[${ip}]` : ip;
}

function buildLoopbackEndpoint(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function buildLocalhostEndpoint(port: number): string {
  return `http://localhost:${port}`;
}

function buildOperationHeaders(
  operation: ApiOperationStatus | null,
  modelId?: string,
): Record<string, string> {
  return {
    'X-Offgrid-Api-Version': '1',
    ...(modelId ? { 'X-Offgrid-Model': modelId } : {}),
    ...(operation
      ? {
          'X-Offgrid-Operation-Id': operation.id,
          'X-Offgrid-Stage': operation.stage,
        }
      : {}),
  };
}

function isUnloadPath(path: string): boolean {
  return (
    path === '/v1/models/unload' ||
    /^\/v1\/models\/unload\/(text|image|all)$/.test(path)
  );
}

function isLoadPath(path: string): boolean {
  return path === '/v1/models/load' || /^\/v1\/models\/load\/(text|image)$/.test(path);
}

function isReloadPath(path: string): boolean {
  return path === '/v1/models/reload' || /^\/v1\/models\/reload\/(text|image|all)$/.test(path);
}

function isDeleteModelPath(path: string): boolean {
  return path === '/v1/models/delete' || /^\/v1\/models\/delete\/(text|image)$/.test(path);
}

function isStopGenerationPath(path: string): boolean {
  return (
    path === '/v1/generation/stop' ||
    path === '/v1/generation/cancel' ||
    /^\/v1\/generation\/(stop|cancel)\/(text|image|all)$/.test(path)
  );
}

function isCacheClearPath(path: string): boolean {
  return path === '/v1/cache/clear' || /^\/v1\/cache\/clear\/(text|image|all)$/.test(path);
}

function isServerActionPath(path: string): boolean {
  return /^\/v1\/server\/(reload|restart|stop)$/.test(path);
}

function isSettingsPath(path: string): boolean {
  return path === '/v1/settings' || path === '/v1/offgrid/settings';
}

function isCapabilitiesPath(path: string): boolean {
  return path === '/v1/capabilities' || path === '/v1/offgrid/capabilities';
}

class LocalApiServerService {
  private eventEmitter: NativeEventEmitter | null = null;
  private requestSubscription: { remove: () => void } | null = null;
  private listeners = new Set<StatusListener>();
  private workQueue: Promise<void> = Promise.resolve();
  private operations = new ApiOperationTracker();
  private status: LocalApiServerStatus = {
    isRunning: false,
    port: 3333,
    endpoint: null,
    lanEndpoint: null,
    loopbackEndpoint: null,
    localhostEndpoint: null,
    listenerReady: false,
    lastError: null,
  };

  constructor() {
    if (this.isAvailable()) {
      this.eventEmitter = new NativeEventEmitter(LocalApiServerModule);
      this.ensureRequestListener();
    }
  }

  isAvailable(): boolean {
    return Platform.OS === 'android' && !!LocalApiServerModule;
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  getStatus(): LocalApiServerStatus {
    return { ...this.status };
  }

  async configure(): Promise<void> {
    if (!this.isAvailable()) return;

    this.ensureRequestListener();
    const settings = useAppStore.getState().settings;

    if (!settings.localApiServerEnabled) {
      await this.stop();
      return;
    }

    try {
      const nativeStatus = await LocalApiServerModule!.startServer({
        port: settings.localApiServerPort,
        apiKey: settings.localApiServerApiKey,
      });
      await this.updateStatus(nativeStatus, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[LocalApiServer] Failed to configure server:', error);
      this.setStatus({
        ...this.status,
        isRunning: false,
        endpoint: null,
        lanEndpoint: null,
        loopbackEndpoint: null,
        localhostEndpoint: null,
        lastError: message,
      });
    }
  }

  async stop(): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      const nativeStatus = await LocalApiServerModule!.stopServer();
      await this.updateStatus(nativeStatus, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[LocalApiServer] Failed to stop server:', error);
      this.setStatus({
        ...this.status,
        isRunning: false,
        endpoint: null,
        lanEndpoint: null,
        loopbackEndpoint: null,
        localhostEndpoint: null,
        lastError: message,
      });
    }
  }

  async refreshStatus(): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      const nativeStatus = await LocalApiServerModule!.getStatus();
      await this.updateStatus(nativeStatus, this.status.lastError);
    } catch (error) {
      logger.warn('[LocalApiServer] Failed to refresh status:', error);
    }
  }

  async shutdown(): Promise<void> {
    if (this.requestSubscription) {
      this.requestSubscription.remove();
      this.requestSubscription = null;
    }
    await this.stop();
  }

  private ensureRequestListener(): void {
    if (!this.eventEmitter || this.requestSubscription) return;

    this.requestSubscription = this.eventEmitter.addListener(
      'LocalApiServerRequest',
      (event: NativeApiRequest) => {
        if (event.method === 'GET' && event.path === '/v1/status') {
          this.handleRequest(event).catch(error =>
            logger.warn('[LocalApiServer] Status request failed:', error),
          );
          return;
        }
        this.enqueue(async () => {
          await this.handleRequest(event);
        });
      },
    );
  }

  private enqueue(task: () => Promise<void>): void {
    const run = this.workQueue.catch(() => undefined).then(task);
    this.workQueue = run.then(
      () => undefined,
      () => undefined,
    );
  }

  private async handleRequest(event: NativeApiRequest): Promise<void> {
    try {
      if (event.method === 'GET' && isCapabilitiesPath(event.path)) {
        await this.handleCapabilitiesRequest(event.requestId);
        return;
      }

      if (event.method === 'GET' && event.path === '/v1/models') {
        await this.handleModelsRequest(event.requestId);
        return;
      }

      if (event.method === 'GET' && event.path === '/v1/status') {
        await this.handleStatusRequest(event.requestId);
        return;
      }

      if (isSettingsPath(event.path)) {
        await this.handleSettingsRequest(event);
        return;
      }

      if (event.method === 'POST' && event.path === '/v1/chat/completions') {
        await this.handleChatRequest(event);
        return;
      }

      if (event.method === 'POST' && event.path === '/v1/images/generations') {
        await this.handleImageRequest(event);
        return;
      }

      if (event.method === 'POST' && isLoadPath(event.path)) {
        await this.handleLoadModelRequest(event);
        return;
      }

      if (event.method === 'POST' && isReloadPath(event.path)) {
        await this.handleReloadModelRequest(event);
        return;
      }

      if (event.method === 'POST' && isUnloadPath(event.path)) {
        await this.handleUnloadRequest(event);
        return;
      }

      if (event.method === 'POST' && isDeleteModelPath(event.path)) {
        await this.handleDeleteModelRequest(event);
        return;
      }

      if (event.method === 'POST' && isStopGenerationPath(event.path)) {
        await this.handleStopGenerationRequest(event);
        return;
      }

      if (event.method === 'POST' && isCacheClearPath(event.path)) {
        await this.handleCacheClearRequest(event);
        return;
      }

      if (this.isGalleryRequest(event)) {
        await this.handleGalleryRequest(event);
        return;
      }

      if (this.isDownloadRequest(event)) {
        await this.handleDownloadRequest(event);
        return;
      }

      if (this.isStorageRequest(event)) {
        await this.handleStorageRequest(event);
        return;
      }

      if (event.method === 'POST' && isServerActionPath(event.path)) {
        await this.handleServerActionRequest(event);
        return;
      }

      throw new ApiRequestError(
        404,
        `Unsupported endpoint: ${event.method} ${event.path}`,
      );
    } catch (error) {
      const { status, message } = normalizeApiError(error);
      const operation = this.operations.fail(message);
      logger.warn('[LocalApiServer] Request failed:', message);
      try {
        await LocalApiServerModule?.respondJson(
          event.requestId,
          status,
          buildErrorResponse(message, { status, operation }),
          buildOperationHeaders(operation),
        );
      } catch (nativeError) {
        logger.warn(
          '[LocalApiServer] Failed to send error response:',
          nativeError,
        );
      }
    }
  }

  private async handleModelsRequest(requestId: string): Promise<void> {
    const state = useAppStore.getState();
    const body = buildModelsResponse(
      state.downloadedModels,
      state.downloadedImageModels,
    );
    await LocalApiServerModule?.respondJson(requestId, 200, body, {
      'X-Offgrid-Api-Version': '1',
      'X-Offgrid-Text-Models': String(state.downloadedModels.length),
      'X-Offgrid-Image-Models': String(state.downloadedImageModels.length),
    });
  }

  private async handleCapabilitiesRequest(requestId: string): Promise<void> {
    await LocalApiServerModule?.respondJson(
      requestId,
      200,
      buildCapabilitiesResponse(),
      buildOperationHeaders(null),
    );
  }

  private async handleStatusRequest(requestId: string): Promise<void> {
    const state = useAppStore.getState();
    let resourceUsage: Record<string, unknown> | null = null;
    try {
      resourceUsage =
        (await activeModelService.getResourceUsage()) as unknown as Record<
          string,
          unknown
        >;
    } catch (error) {
      logger.warn('[LocalApiServer] Resource usage unavailable:', error);
    }

    const body = buildStatusResponse({
      server: this.status,
      modelCounts: {
        text: state.downloadedModels.length,
        image: state.downloadedImageModels.length,
      },
      activeModels: {
        textModelId: state.activeModelId,
        imageModelId: state.activeImageModelId,
      },
      loadedModels: activeModelService.getLoadedModelIds(),
      operation: this.operations.snapshot(),
      resourceUsage,
      runtime: this.getRuntimeStatus(),
    });
    await LocalApiServerModule?.respondJson(
      requestId,
      200,
      body,
      buildOperationHeaders(null),
    );
  }

  private async handleSettingsRequest(event: NativeApiRequest): Promise<void> {
    if (event.method === 'GET') {
      const settings = this.redactSettings(useAppStore.getState().settings);
      await LocalApiServerModule?.respondJson(
        event.requestId,
        200,
        JSON.stringify({ object: 'offgrid.settings', settings }),
        buildOperationHeaders(null),
      );
      return;
    }

    if (event.method !== 'POST' && event.method !== 'PATCH') {
      throw new ApiRequestError(405, 'Settings endpoint supports GET and POST');
    }

    this.operations.start({
      type: 'settings',
      requestId: event.requestId,
      stage: 'settings_update',
      message: 'Applying API settings update.',
    });

    const state = useAppStore.getState();
    const patch = this.filterSettingsPatch(parseSettingsPatchRequest(event.body));
    state.updateSettings(patch as any);

    const shouldReconfigure =
      'localApiServerEnabled' in patch ||
      'localApiServerPort' in patch ||
      'localApiServerApiKey' in patch;
    const operation = this.operations.complete('Settings updated.');
    await LocalApiServerModule?.respondJson(
      event.requestId,
      200,
      buildActionResponse({
        object: 'offgrid.settings.updated',
        data: {
          settings: this.redactSettings(useAppStore.getState().settings),
          applied: patch,
          server_reconfigure_scheduled: shouldReconfigure,
        },
        operation,
      }),
      buildOperationHeaders(operation),
    );

    if (shouldReconfigure) {
      setTimeout(() => {
        this.configure().catch(error =>
          logger.warn('[LocalApiServer] Settings reconfigure failed:', error),
        );
      }, 250);
    }
  }

  private async handleLoadModelRequest(event: NativeApiRequest): Promise<void> {
    const parsed = parseModelControlRequest(event.body, event.path, 'load');
    const target = this.resolveControlTarget(parsed.target, parsed.modelId);
    if (target === 'all') {
      throw new ApiRequestError(400, 'Load requires target "text" or "image"');
    }
    const modelId = this.resolveModelIdForTarget(target, parsed.modelId);
    this.operations.start({
      type: 'load',
      requestId: event.requestId,
      modelId,
      stage: 'load_start',
      message: `Loading ${target} model for API management request.`,
    });

    await ensureApiModelReady({
      target,
      modelId,
      progress: (stage, message, details) =>
        this.operations.update(stage, message, details),
    });
    await activeModelService.syncWithNativeState();
    const operation = this.operations.complete('Model load completed.');
    await LocalApiServerModule?.respondJson(
      event.requestId,
      200,
      buildActionResponse({
        object: 'offgrid.models.load',
        data: {
          target,
          model: modelId,
          loaded_models: this.formatLoadedModels(),
        },
        operation,
      }),
      buildOperationHeaders(operation, modelId),
    );
  }

  private async handleReloadModelRequest(event: NativeApiRequest): Promise<void> {
    const parsed = parseModelControlRequest(event.body, event.path, 'reload');
    const target = this.resolveControlTarget(parsed.target, parsed.modelId);
    this.operations.start({
      type: 'reload',
      requestId: event.requestId,
      modelId: parsed.modelId,
      stage: 'reload_start',
      message: `Reloading ${target} model resources.`,
    });

    const state = useAppStore.getState();
    const loaded: Record<string, string | null> = { text: null, image: null };
    const shouldReloadText =
      target === 'text' || (target === 'all' && state.downloadedModels.length > 0);
    const shouldReloadImage =
      target === 'image' ||
      (target === 'all' && state.downloadedImageModels.length > 0);

    if (shouldReloadText) {
      const textModelId = this.resolveTextModelId(
        target === 'text' ? parsed.modelId : undefined,
      );
      await activeModelService.unloadTextModel();
      await ensureApiModelReady({
        target: 'text',
        modelId: textModelId,
        progress: (stage, message, details) =>
          this.operations.update(stage, message, details),
      });
      loaded.text = textModelId;
    }
    if (shouldReloadImage) {
      const imageModelId = this.resolveImageModelId(
        target === 'image' ? parsed.modelId : undefined,
      );
      await activeModelService.unloadImageModel();
      await ensureApiModelReady({
        target: 'image',
        modelId: imageModelId,
        progress: (stage, message, details) =>
          this.operations.update(stage, message, details),
      });
      loaded.image = imageModelId;
    }

    if (!loaded.text && !loaded.image) {
      throw new ApiRequestError(400, 'No models are available to reload');
    }

    await activeModelService.syncWithNativeState();
    const operation = this.operations.complete('Model reload completed.');
    await LocalApiServerModule?.respondJson(
      event.requestId,
      200,
      buildActionResponse({
        object: 'offgrid.models.reload',
        data: {
          target,
          loaded,
          loaded_models: this.formatLoadedModels(),
        },
        operation,
      }),
      buildOperationHeaders(operation),
    );
  }

  private async handleUnloadRequest(event: NativeApiRequest): Promise<void> {
    const target = parseUnloadRequest(event.body, event.path);
    this.operations.start({
      type: 'unload',
      requestId: event.requestId,
      stage: 'unload_start',
      message: `Unloading ${target} model resources.`,
    });

    const results = { textUnloaded: false, imageUnloaded: false };
    if (target === 'all') {
      Object.assign(results, await activeModelService.unloadAllModels());
    } else if (target === 'text') {
      await activeModelService.unloadTextModel();
      results.textUnloaded = true;
    } else {
      await activeModelService.unloadImageModel();
      results.imageUnloaded = true;
    }

    await activeModelService.syncWithNativeState();
    const operation = this.operations.complete('Unload request completed.');
    const body = buildUnloadResponse({
      target,
      ...results,
      loadedModels: activeModelService.getLoadedModelIds(),
      operation,
    });
    await LocalApiServerModule?.respondJson(
      event.requestId,
      200,
      body,
      buildOperationHeaders(operation),
    );
  }

  private async handleDeleteModelRequest(event: NativeApiRequest): Promise<void> {
    const parsed = parseModelControlRequest(event.body, event.path, 'delete');
    if (!parsed.modelId) {
      throw new ApiRequestError(400, 'model or model_id is required');
    }
    const target = this.resolveControlTarget(parsed.target, parsed.modelId);
    if (target === 'all') {
      throw new ApiRequestError(400, 'Delete requires target "text" or "image"');
    }

    this.operations.start({
      type: 'delete',
      requestId: event.requestId,
      modelId: parsed.modelId,
      stage: 'delete_start',
      message: `Deleting ${target} model files.`,
    });

    if (target === 'text') {
      await this.unloadIfModelMatches('text', parsed.modelId);
      await modelManager.deleteModel(parsed.modelId);
      useAppStore.getState().removeDownloadedModel(parsed.modelId);
    } else {
      await this.unloadIfModelMatches('image', parsed.modelId);
      await modelManager.deleteImageModel(parsed.modelId);
      useAppStore.getState().removeDownloadedImageModel(parsed.modelId);
    }

    const operation = this.operations.complete('Model deleted.');
    await LocalApiServerModule?.respondJson(
      event.requestId,
      200,
      buildActionResponse({
        object: 'offgrid.models.delete',
        data: { target, model: parsed.modelId },
        operation,
      }),
      buildOperationHeaders(operation),
    );
  }

  private async handleStopGenerationRequest(
    event: NativeApiRequest,
  ): Promise<void> {
    const parsed = parseStopRequest(event.body, event.path);
    this.operations.start({
      type: 'stop',
      requestId: event.requestId,
      stage: 'stop_start',
      message: `Stopping ${parsed.target} generation work.`,
    });

    const stopped = { text: false, image: false };
    if (parsed.target === 'all' || parsed.target === 'text') {
      await generationService.stopGeneration().catch(() => undefined);
      await llmService.stopGeneration().catch(() => undefined);
      stopped.text = true;
    }
    if (parsed.target === 'all' || parsed.target === 'image') {
      await imageGenerationService.cancelGeneration().catch(() => undefined);
      await localDreamGeneratorService.cancelGeneration().catch(() => false);
      stopped.image = true;
    }

    const operation = this.operations.complete('Generation stop completed.');
    await LocalApiServerModule?.respondJson(
      event.requestId,
      200,
      buildActionResponse({
        object: 'offgrid.generation.stop',
        data: { target: parsed.target, stopped },
        operation,
      }),
      buildOperationHeaders(operation),
    );
  }

  private async handleCacheClearRequest(event: NativeApiRequest): Promise<void> {
    const parsed = parseCacheClearRequest(event.body, event.path);
    this.operations.start({
      type: 'cache',
      requestId: event.requestId,
      stage: 'cache_clear_start',
      message: `Clearing ${parsed.target} cache resources.`,
    });

    const cleared: { text: boolean; image: boolean; imageCacheFiles: number } = {
      text: false,
      image: false,
      imageCacheFiles: 0,
    };

    if (parsed.target === 'all' || parsed.target === 'text') {
      await llmService.clearKVCache(parsed.clearData);
      cleared.text = true;
    }

    if (parsed.target === 'all' || parsed.target === 'image') {
      const imageModel = this.getActiveImageModel();
      if (imageModel?.modelPath) {
        cleared.imageCacheFiles = await localDreamGeneratorService
          .clearOpenCLCache(imageModel.modelPath)
          .catch(() => 0);
      }
      cleared.image = true;
    }

    const operation = this.operations.complete('Cache clear completed.');
    await LocalApiServerModule?.respondJson(
      event.requestId,
      200,
      buildActionResponse({
        object: 'offgrid.cache.clear',
        data: { target: parsed.target, clear_data: parsed.clearData, cleared },
        operation,
      }),
      buildOperationHeaders(operation),
    );
  }

  private isGalleryRequest(event: NativeApiRequest): boolean {
    return (
      (event.method === 'GET' && event.path === '/v1/gallery/images') ||
      (event.method === 'POST' &&
        (event.path === '/v1/gallery/delete' ||
          event.path === '/v1/gallery/images/delete')) ||
      (event.method === 'DELETE' && /^\/v1\/gallery\/images\/[^/]+$/.test(event.path))
    );
  }

  private async handleGalleryRequest(event: NativeApiRequest): Promise<void> {
    if (event.method === 'GET') {
      const images = await this.syncGalleryImages();
      await LocalApiServerModule?.respondJson(
        event.requestId,
        200,
        JSON.stringify({
          object: 'offgrid.gallery.images',
          data: images,
          count: images.length,
        }),
        buildOperationHeaders(null),
      );
      return;
    }

    const parsed = parseGalleryDeleteRequest(event.body, event.path);
    if (!parsed.all && !parsed.conversationId && parsed.ids.length === 0) {
      throw new ApiRequestError(
        400,
        'Provide id, ids, conversation_id, or all=true',
      );
    }

    this.operations.start({
      type: 'gallery',
      requestId: event.requestId,
      stage: 'gallery_delete_start',
      message: 'Deleting generated gallery images.',
    });

    const deleted = await this.deleteGalleryImages(parsed);
    const operation = this.operations.complete('Gallery deletion completed.');
    await LocalApiServerModule?.respondJson(
      event.requestId,
      200,
      buildActionResponse({
        object: 'offgrid.gallery.delete',
        data: deleted,
        operation,
      }),
      buildOperationHeaders(operation),
    );
  }

  private isDownloadRequest(event: NativeApiRequest): boolean {
    return (
      (event.method === 'GET' && event.path === '/v1/downloads') ||
      (event.method === 'POST' &&
        (event.path === '/v1/downloads/cancel' ||
          /^\/v1\/downloads\/cancel\/\d+$/.test(event.path)))
    );
  }

  private async handleDownloadRequest(event: NativeApiRequest): Promise<void> {
    if (event.method === 'GET') {
      const persisted = useAppStore.getState().activeBackgroundDownloads;
      const active = await modelManager.getActiveBackgroundDownloads();
      await LocalApiServerModule?.respondJson(
        event.requestId,
        200,
        JSON.stringify({
          object: 'offgrid.downloads',
          active,
          persisted,
        }),
        buildOperationHeaders(null),
      );
      return;
    }

    const { downloadId } = parseDownloadCancelRequest(event.body, event.path);
    this.operations.start({
      type: 'download',
      requestId: event.requestId,
      stage: 'download_cancel_start',
      message: `Cancelling background download ${downloadId}.`,
    });
    await modelManager.cancelBackgroundDownload(downloadId);
    useAppStore.getState().setBackgroundDownload(downloadId, null);
    const operation = this.operations.complete('Download cancellation completed.');
    await LocalApiServerModule?.respondJson(
      event.requestId,
      200,
      buildActionResponse({
        object: 'offgrid.downloads.cancel',
        data: { download_id: downloadId },
        operation,
      }),
      buildOperationHeaders(operation),
    );
  }

  private isStorageRequest(event: NativeApiRequest): boolean {
    return (
      (event.method === 'GET' && event.path === '/v1/storage') ||
      (event.method === 'POST' &&
        (event.path === '/v1/storage/scan' ||
          event.path === '/v1/storage/orphans/delete'))
    );
  }

  private async handleStorageRequest(event: NativeApiRequest): Promise<void> {
    if (event.method === 'GET') {
      const storage = await this.getStorageSnapshot();
      await LocalApiServerModule?.respondJson(
        event.requestId,
        200,
        JSON.stringify({ object: 'offgrid.storage', ...storage }),
        buildOperationHeaders(null),
      );
      return;
    }

    if (event.path === '/v1/storage/scan') {
      this.operations.start({
        type: 'storage',
        requestId: event.requestId,
        stage: 'storage_scan_start',
        message: 'Scanning model storage and orphaned files.',
      });
      const refreshed = await modelManager.refreshModelLists();
      const store = useAppStore.getState();
      store.setDownloadedModels(refreshed.textModels);
      store.setDownloadedImageModels(refreshed.imageModels);
      const storage = await this.getStorageSnapshot();
      const operation = this.operations.complete('Storage scan completed.');
      await LocalApiServerModule?.respondJson(
        event.requestId,
        200,
        buildActionResponse({
          object: 'offgrid.storage.scan',
          data: {
            text_models: refreshed.textModels.length,
            image_models: refreshed.imageModels.length,
            ...storage,
          },
          operation,
        }),
        buildOperationHeaders(operation),
      );
      return;
    }

    const body = this.parseBodyObject(event.body);
    const path = typeof body.path === 'string' ? body.path : '';
    if (!path) throw new ApiRequestError(400, 'path is required');
    const orphans = await modelManager.getOrphanedFiles();
    if (!orphans.some(file => file.path === path)) {
      throw new ApiRequestError(404, 'Path is not a known orphaned file');
    }
    await modelManager.deleteOrphanedFile(path);
    await LocalApiServerModule?.respondJson(
      event.requestId,
      200,
      buildActionResponse({
        object: 'offgrid.storage.orphans.delete',
        data: { path },
      }),
      buildOperationHeaders(null),
    );
  }

  private async handleServerActionRequest(event: NativeApiRequest): Promise<void> {
    const action = event.path.match(/^\/v1\/server\/(reload|restart|stop)$/)?.[1];
    if (!action) throw new ApiRequestError(404, 'Unknown server action');

    this.operations.start({
      type: 'server',
      requestId: event.requestId,
      stage: `server_${action}`,
      message: `Scheduling API server ${action}.`,
    });
    const operation = this.operations.complete(`API server ${action} scheduled.`);
    await LocalApiServerModule?.respondJson(
      event.requestId,
      action === 'reload' ? 200 : 202,
      buildActionResponse({
        object: `offgrid.server.${action}`,
        data: { scheduled: true, action },
        operation,
      }),
      buildOperationHeaders(operation),
    );

    setTimeout(() => {
      this.runScheduledServerAction(action).catch(error =>
        logger.warn(`[LocalApiServer] Server ${action} failed:`, error),
      );
    }, 250);
  }

  private async handleChatRequest(event: NativeApiRequest): Promise<void> {
    const parsed = parseChatRequest(event.body);
    const selectedModelId = this.resolveTextModelId(parsed.modelId);
    const completionId = `chatcmpl-${Date.now()}`;

    this.operations.start({
      type: 'chat',
      requestId: event.requestId,
      modelId: selectedModelId,
      stage: 'accepted',
      message: 'Chat completion request accepted.',
    });

    if (parsed.stream) {
      const result = await streamLocalChatCompletion({
        nativeModule: LocalApiServerModule!,
        requestId: event.requestId,
        completionId,
        modelId: selectedModelId,
        messages: parsed.messages,
        options: parsed.options,
        prepare: async emitStatus => {
          await ensureApiModelReady({
            target: 'text',
            modelId: selectedModelId,
            progress: (stage, message, details) => {
              const status = this.operations.update(stage, message, details);
              if (status) emitStatus(status);
              return status;
            },
          });
          const status = this.operations.update(
            'generate',
            'Text model is ready. Starting token generation.',
          );
          if (status) emitStatus(status);
        },
      });
      if (result.ok) this.operations.complete('Chat stream completed.');
      else this.operations.fail(result.error || 'Chat stream failed.');
      return;
    }

    await ensureApiModelReady({
      target: 'text',
      modelId: selectedModelId,
      progress: (stage, message, details) =>
        this.operations.update(stage, message, details),
    });
    this.operations.update(
      'generate',
      'Text model is ready. Starting completion generation.',
    );
    const result = await runLocalCompletion(parsed.messages, parsed.options);
    const operation = this.operations.complete('Chat completion ready.');
    const body = buildChatCompletionResponse({
      id: completionId,
      modelId: selectedModelId,
      content: result.content,
      reasoningContent: result.reasoningContent,
      toolCalls: result.toolCalls,
      finishReason: result.toolCalls?.length ? 'tool_calls' : 'stop',
      completionTokens: result.meta?.tokenCount,
      offgrid: { operation },
    });
    await LocalApiServerModule?.respondJson(
      event.requestId,
      200,
      body,
      buildOperationHeaders(operation, selectedModelId),
    );
  }

  private async handleImageRequest(event: NativeApiRequest): Promise<void> {
    const parsed = parseImageRequest(event.body);
    const selectedModelId = this.resolveImageModelId(parsed.modelId);
    this.operations.start({
      type: 'image',
      requestId: event.requestId,
      modelId: selectedModelId,
      stage: 'accepted',
      message: 'Image generation request accepted.',
    });

    await ensureApiModelReady({
      target: 'image',
      modelId: selectedModelId,
      progress: (stage, message, details) =>
        this.operations.update(stage, message, details),
    });

    const settings = useAppStore.getState().settings;
    this.operations.update(
      'generate_image',
      'Image model is ready. Starting image generation.',
      {
        width: parsed.width ?? settings.imageWidth,
        height: parsed.height ?? settings.imageHeight,
        steps: parsed.steps ?? settings.imageSteps,
      },
    );
    const result = await localDreamGeneratorService.generateImage({
      prompt: parsed.prompt,
      negativePrompt: parsed.negativePrompt,
      steps: parsed.steps ?? settings.imageSteps,
      guidanceScale: parsed.guidanceScale ?? settings.imageGuidanceScale,
      seed: parsed.seed,
      width: parsed.width ?? settings.imageWidth,
      height: parsed.height ?? settings.imageHeight,
      useOpenCL: settings.imageUseOpenCL,
    });

    this.operations.update(
      'encode_image',
      'Encoding generated image for OpenAI-compatible response.',
    );
    const base64Png = await RNFS.readFile(result.imagePath, 'base64');
    const operation = this.operations.complete('Image generation completed.');
    const body = buildImageGenerationResponse({
      base64Png,
      prompt: parsed.prompt,
      responseFormat: parsed.responseFormat,
      offgrid: { operation },
    });
    await LocalApiServerModule?.respondJson(
      event.requestId,
      200,
      body,
      buildOperationHeaders(operation, selectedModelId),
    );
  }

  private getRuntimeStatus(): Record<string, unknown> {
    const textState = generationService.getState();
    const imageState = imageGenerationService.getState();
    const appState = useAppStore.getState();
    return {
      text_generation: {
        is_generating: textState.isGenerating,
        is_thinking: textState.isThinking,
        conversation_id: textState.conversationId,
        streaming_content_length: textState.streamingContent.length,
        queued_messages: textState.queuedMessages.length,
        llm_is_generating: llmService.isCurrentlyGenerating(),
        performance: llmService.getPerformanceStats(),
        gpu: llmService.getGpuInfo(),
      },
      image_generation: {
        is_generating: imageState.isGenerating,
        status: imageState.status,
        progress: imageState.progress,
        prompt: imageState.prompt,
        conversation_id: imageState.conversationId,
        error: imageState.error,
        has_preview: Boolean(imageState.previewPath),
        native_is_generating: appState.isGeneratingImage,
      },
      downloads: {
        persisted_count: Object.keys(appState.activeBackgroundDownloads).length,
        progress_count: Object.keys(appState.downloadProgress).length,
      },
      gallery: {
        image_count: appState.generatedImages.length,
      },
    };
  }

  private parseBodyObject(body: string): Record<string, any> {
    try {
      const parsed = body ? JSON.parse(body) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not object');
      }
      return parsed;
    } catch {
      throw new ApiRequestError(400, 'Request body must be a valid JSON object');
    }
  }

  private redactSettings(settings: any): Record<string, unknown> {
    return {
      ...settings,
      localApiServerApiKey: settings.localApiServerApiKey ? '***' : '',
      localApiServerApiKeyConfigured: Boolean(settings.localApiServerApiKey),
    };
  }

  private filterSettingsPatch(
    patch: Record<string, unknown>,
  ): Record<string, unknown> {
    const current = useAppStore.getState().settings as Record<string, unknown>;
    const filtered: Record<string, unknown> = {};

    Object.entries(patch).forEach(([key, value]) => {
      if (!(key in current)) return;
      const existing = current[key];
      if (Array.isArray(existing)) {
        if (Array.isArray(value)) filtered[key] = value;
        return;
      }
      if (typeof existing === 'number') {
        if (typeof value === 'number' && Number.isFinite(value)) {
          filtered[key] = key === 'localApiServerPort'
            ? Math.max(1, Math.min(65535, Math.round(value)))
            : value;
        }
        return;
      }
      if (existing === null) {
        if (value === null || typeof value === 'string') filtered[key] = value;
        return;
      }
      if (typeof value === typeof existing) filtered[key] = value;
    });

    if (Object.keys(filtered).length === 0) {
      throw new ApiRequestError(400, 'No valid settings fields were provided');
    }
    return filtered;
  }

  private resolveControlTarget(
    requestedTarget?: ApiControlTarget,
    modelId?: string,
  ): ApiControlTarget {
    if (requestedTarget) return requestedTarget;
    const state = useAppStore.getState();
    if (modelId) {
      if (state.downloadedModels.some(model => model.id === modelId)) {
        return 'text';
      }
      if (state.downloadedImageModels.some(model => model.id === modelId)) {
        return 'image';
      }
      throw new ApiRequestError(404, `Unknown model: ${modelId}`);
    }
    if (state.activeModelId || state.downloadedModels.length > 0) return 'text';
    if (state.activeImageModelId || state.downloadedImageModels.length > 0) {
      return 'image';
    }
    throw new ApiRequestError(400, 'No local models are available');
  }

  private resolveModelIdForTarget(
    target: Exclude<ApiControlTarget, 'all'>,
    modelId?: string,
  ): string {
    return target === 'text'
      ? this.resolveTextModelId(modelId)
      : this.resolveImageModelId(modelId);
  }

  private formatLoadedModels(): { text: string | null; image: string | null } {
    const loaded = activeModelService.getLoadedModelIds();
    return {
      text: loaded.textModelId,
      image: loaded.imageModelId,
    };
  }

  private async unloadIfModelMatches(
    target: Exclude<ApiControlTarget, 'all'>,
    modelId: string,
  ): Promise<void> {
    const state = useAppStore.getState();
    const loaded = activeModelService.getLoadedModelIds();
    if (
      target === 'text' &&
      (loaded.textModelId === modelId || state.activeModelId === modelId)
    ) {
      await activeModelService.unloadTextModel();
    }
    if (
      target === 'image' &&
      (loaded.imageModelId === modelId || state.activeImageModelId === modelId)
    ) {
      await activeModelService.unloadImageModel();
    }
  }

  private getActiveImageModel() {
    const state = useAppStore.getState();
    return state.downloadedImageModels.find(
      model => model.id === state.activeImageModelId,
    );
  }

  private async syncGalleryImages() {
    const store = useAppStore.getState();
    try {
      const diskImages = await localDreamGeneratorService.getGeneratedImages();
      const existingIds = new Set(store.generatedImages.map(img => img.id));
      diskImages.forEach(image => {
        if (!existingIds.has(image.id)) store.addGeneratedImage(image);
      });
    } catch (error) {
      logger.warn('[LocalApiServer] Gallery disk sync failed:', error);
    }
    return useAppStore.getState().generatedImages;
  }

  private async deleteGalleryImages(parsed: {
    ids: string[];
    conversationId?: string;
    all: boolean;
  }): Promise<Record<string, unknown>> {
    const store = useAppStore.getState();
    const images = await this.syncGalleryImages();
    const knownIds = new Set(images.map(image => image.id));
    const ids = new Set(parsed.ids);
    if (parsed.conversationId) {
      store
        .removeImagesByConversationId(parsed.conversationId)
        .forEach(id => ids.add(id));
    }
    if (parsed.all) {
      images.forEach(image => ids.add(image.id));
      store.clearGeneratedImages();
    }

    const deleted: string[] = [];
    const failed: string[] = [];
    for (const imageId of ids) {
      const ok = await localDreamGeneratorService
        .deleteGeneratedImage(imageId)
        .catch(() => false);
      if (ok || knownIds.has(imageId)) {
        store.removeGeneratedImage(imageId);
        deleted.push(imageId);
      } else {
        failed.push(imageId);
      }
    }

    return {
      deleted_ids: deleted,
      failed_ids: failed,
      remaining: useAppStore.getState().generatedImages.length,
    };
  }

  private async getStorageSnapshot(): Promise<Record<string, unknown>> {
    const [textBytes, imageBytes, availableBytes, orphans] = await Promise.all([
      modelManager.getStorageUsed().catch(() => 0),
      modelManager.getImageModelsStorageUsed().catch(() => 0),
      modelManager.getAvailableStorage().catch(() => 0),
      modelManager.getOrphanedFiles().catch(() => []),
    ]);
    return {
      text_model_bytes: textBytes,
      image_model_bytes: imageBytes,
      total_model_bytes: textBytes + imageBytes,
      available_bytes: availableBytes,
      orphaned_files: orphans,
    };
  }

  private async runScheduledServerAction(action: string): Promise<void> {
    const store = useAppStore.getState();
    if (action === 'stop') {
      store.updateSettings({ localApiServerEnabled: false });
      await this.stop();
      return;
    }
    if (action === 'restart') {
      store.updateSettings({ localApiServerEnabled: true });
      await this.stop();
      await this.configure();
      return;
    }
    await this.configure();
  }

  private resolveTextModelId(requestedModelId?: string): string {
    const store = useAppStore.getState();
    const selectedModelId =
      requestedModelId ||
      getDefaultTextModelId(store.downloadedModels, store.activeModelId);
    if (!selectedModelId) {
      throw new ApiRequestError(
        400,
        'No local text model is selected. Choose one in the app or pass "model".',
      );
    }
    if (!store.downloadedModels.some(model => model.id === selectedModelId)) {
      throw new ApiRequestError(
        404,
        `Unknown local text model: ${selectedModelId}`,
      );
    }
    return selectedModelId;
  }

  private resolveImageModelId(requestedModelId?: string): string {
    const store = useAppStore.getState();
    const selectedModelId =
      requestedModelId ||
      getDefaultImageModelId(
        store.downloadedImageModels,
        store.activeImageModelId,
      );
    if (!selectedModelId) {
      throw new ApiRequestError(
        400,
        'No local image model is selected. Choose one in the app or pass "model".',
      );
    }
    if (
      !store.downloadedImageModels.some(model => model.id === selectedModelId)
    ) {
      throw new ApiRequestError(
        404,
        `Unknown local image model: ${selectedModelId}`,
      );
    }
    return selectedModelId;
  }

  private async updateStatus(
    nativeStatus: NativeStatus,
    lastError: string | null,
  ): Promise<void> {
    const lanIp = nativeStatus.isRunning ? await this.getLanIp() : null;
    const lanEndpoint = lanIp
      ? `http://${formatHostForUrl(lanIp)}:${nativeStatus.port}`
      : null;
    const loopbackEndpoint = nativeStatus.isRunning
      ? buildLoopbackEndpoint(nativeStatus.port)
      : null;
    const localhostEndpoint = nativeStatus.isRunning
      ? buildLocalhostEndpoint(nativeStatus.port)
      : null;
    this.setStatus({
      isRunning: nativeStatus.isRunning,
      port: nativeStatus.port,
      listenerReady: nativeStatus.listenerReady,
      endpoint: lanEndpoint ?? loopbackEndpoint,
      lanEndpoint,
      loopbackEndpoint,
      localhostEndpoint,
      lastError,
    });
  }

  private async getLanIp(): Promise<string | null> {
    try {
      const ip = await DeviceInfo.getIpAddress();
      if (!ip || ip === '0.0.0.0' || ip === '127.0.0.1') return null;
      return ip;
    } catch {
      return null;
    }
  }

  private setStatus(nextStatus: LocalApiServerStatus): void {
    this.status = nextStatus;
    this.listeners.forEach(listener => listener(nextStatus));
  }
}

export const localApiServerService = new LocalApiServerService();
