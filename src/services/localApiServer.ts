/* eslint-disable max-lines */
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import DeviceInfo from 'react-native-device-info';
import RNFS from 'react-native-fs';
import { activeModelService } from './activeModelService';
import { localDreamGeneratorService } from './localDreamGenerator';
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
  buildChatCompletionResponse,
  buildErrorResponse,
  buildImageGenerationResponse,
  buildModelsResponse,
  buildStatusResponse,
  buildUnloadResponse,
  getDefaultImageModelId,
  getDefaultTextModelId,
  normalizeApiError,
  parseChatRequest,
  parseImageRequest,
  parseUnloadRequest,
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
      if (event.method === 'GET' && event.path === '/v1/models') {
        await this.handleModelsRequest(event.requestId);
        return;
      }

      if (event.method === 'GET' && event.path === '/v1/status') {
        await this.handleStatusRequest(event.requestId);
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

      if (event.method === 'POST' && isUnloadPath(event.path)) {
        await this.handleUnloadRequest(event);
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
    });
    await LocalApiServerModule?.respondJson(
      requestId,
      200,
      body,
      buildOperationHeaders(null),
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
