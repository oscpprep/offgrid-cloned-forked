import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import DeviceInfo from 'react-native-device-info';
import RNFS from 'react-native-fs';
import { activeModelService } from './activeModelService';
import { localProvider } from './providers/localProvider';
import { localDreamGeneratorService } from './localDreamGenerator';
import { useAppStore } from '../stores';
import type { CompletionResult } from './providers';
import logger from '../utils/logger';
import {
  ApiRequestError,
  buildChatChunk,
  buildChatCompletionResponse,
  buildErrorResponse,
  buildImageGenerationResponse,
  buildModelsResponse,
  getDefaultImageModelId,
  getDefaultTextModelId,
  parseChatRequest,
  parseImageRequest,
  type NativeApiRequest,
} from './localApiServerHelpers';

const { LocalApiServerModule } = NativeModules as {
  LocalApiServerModule?: {
    startServer: (config: { port: number; apiKey: string }) => Promise<{ isRunning: boolean; port: number; listenerReady: boolean }>;
    stopServer: () => Promise<{ isRunning: boolean; port: number; listenerReady: boolean }>;
    getStatus: () => Promise<{ isRunning: boolean; port: number; listenerReady: boolean }>;
    respondJson: (requestId: string, statusCode: number, body: string, headers?: Record<string, string> | null) => Promise<boolean>;
    startStream: (requestId: string, statusCode: number, headers?: Record<string, string> | null) => Promise<boolean>;
    streamChunk: (requestId: string, chunk: string) => Promise<boolean>;
    finishStream: (requestId: string) => Promise<boolean>;
    failRequest: (requestId: string, statusCode: number, message: string) => Promise<boolean>;
    addListener: (eventName: string) => void;
    removeListeners: (count: number) => void;
  };
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

const STREAM_HEADERS = {
  'X-Offgrid-Api-Version': '1',
};

function formatHostForUrl(ip: string): string {
  return ip.includes(':') && !ip.startsWith('[') ? `[${ip}]` : ip;
}

function buildLoopbackEndpoint(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function buildLocalhostEndpoint(port: number): string {
  return `http://localhost:${port}`;
}

class LocalApiServerService {
  private eventEmitter: NativeEventEmitter | null = null;
  private requestSubscription: { remove: () => void } | null = null;
  private listeners = new Set<StatusListener>();
  private workQueue: Promise<void> = Promise.resolve();
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

    this.requestSubscription = this.eventEmitter.addListener('LocalApiServerRequest', (event: NativeApiRequest) => {
      this.enqueue(async () => {
        await this.handleRequest(event);
      });
    });
  }

  private enqueue(task: () => Promise<void>): void {
    const run = this.workQueue.catch(() => undefined).then(task);
    this.workQueue = run.then(() => undefined, () => undefined);
  }

  private async handleRequest(event: NativeApiRequest): Promise<void> {
    try {
      if (event.method === 'GET' && event.path === '/v1/models') {
        await this.handleModelsRequest(event.requestId);
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

      throw new ApiRequestError(404, `Unsupported endpoint: ${event.method} ${event.path}`);
    } catch (error) {
      const { status, message } = this.normalizeError(error);
      logger.warn('[LocalApiServer] Request failed:', message);
      try {
        await LocalApiServerModule?.respondJson(event.requestId, status, buildErrorResponse(message), null);
      } catch (nativeError) {
        logger.warn('[LocalApiServer] Failed to send error response:', nativeError);
      }
    }
  }

  private async handleModelsRequest(requestId: string): Promise<void> {
    const state = useAppStore.getState();
    const body = buildModelsResponse(state.downloadedModels, state.downloadedImageModels);
    await LocalApiServerModule?.respondJson(requestId, 200, body, {
      'X-Offgrid-Text-Models': String(state.downloadedModels.length),
      'X-Offgrid-Image-Models': String(state.downloadedImageModels.length),
    });
  }

  private async handleChatRequest(event: NativeApiRequest): Promise<void> {
    const parsed = parseChatRequest(event.body);
    const store = useAppStore.getState();
    const selectedModelId = parsed.modelId || getDefaultTextModelId(store.downloadedModels, store.activeModelId);

    if (!selectedModelId) {
      throw new ApiRequestError(400, 'No local text model is selected. Choose one in the app or pass "model".');
    }

    if (!store.downloadedModels.some(model => model.id === selectedModelId)) {
      throw new ApiRequestError(404, `Unknown local text model: ${selectedModelId}`);
    }

    await activeModelService.loadTextModel(selectedModelId);
    await localProvider.loadModel(selectedModelId);

    const completionId = `chatcmpl-${Date.now()}`;
    if (parsed.stream) {
      await this.handleStreamingChat({
        requestId: event.requestId,
        completionId,
        modelId: selectedModelId,
        messages: parsed.messages,
        options: parsed.options,
      });
      return;
    }

    const result = await this.runLocalCompletion(parsed.messages, parsed.options);
    const body = buildChatCompletionResponse({
      id: completionId,
      modelId: selectedModelId,
      content: result.content,
      reasoningContent: result.reasoningContent,
      toolCalls: result.toolCalls,
      finishReason: result.toolCalls?.length ? 'tool_calls' : 'stop',
      completionTokens: result.meta?.tokenCount,
    });
    await LocalApiServerModule?.respondJson(event.requestId, 200, body, {
      'X-Offgrid-Model': selectedModelId,
    });
  }

  private async handleStreamingChat(params: {
    requestId: string;
    completionId: string;
    modelId: string;
    messages: Parameters<typeof localProvider.generate>[0];
    options: Parameters<typeof localProvider.generate>[1];
  }): Promise<void> {
    const { requestId, completionId, modelId, messages, options } = params;
    await LocalApiServerModule?.startStream(requestId, 200, {
      ...STREAM_HEADERS,
      'X-Offgrid-Model': modelId,
    });

    let streamQueue = Promise.resolve();
    const queueChunk = (payload: string) => {
      streamQueue = streamQueue
        .then(() => LocalApiServerModule?.streamChunk(requestId, `data: ${payload}\n\n`))
        .then(() => undefined);
      return streamQueue;
    };

    await queueChunk(buildChatChunk({
      id: completionId,
      modelId,
      delta: { role: 'assistant' },
    }));

    let result: CompletionResult;
    try {
      result = await this.runLocalCompletion(messages, options, {
        onToken: (token) => {
          queueChunk(buildChatChunk({
            id: completionId,
            modelId,
            delta: { content: token },
          }));
        },
        onReasoning: (reasoningContent) => {
          queueChunk(buildChatChunk({
            id: completionId,
            modelId,
            delta: { reasoning_content: reasoningContent },
          }));
        },
      });
    } catch (error) {
      const { message } = this.normalizeError(error);
      await queueChunk(JSON.stringify({ error: { message } }));
      await streamQueue;
      await LocalApiServerModule?.streamChunk(requestId, 'data: [DONE]\n\n');
      await LocalApiServerModule?.finishStream(requestId);
      return;
    }

    if (result.toolCalls?.length) {
      await queueChunk(buildChatChunk({
        id: completionId,
        modelId,
        delta: {
          tool_calls: result.toolCalls.map((toolCall, index) => ({
            index,
            id: toolCall.id || `call_${index + 1}`,
            type: 'function',
            function: {
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
          })),
        },
        finishReason: 'tool_calls',
      }));
    } else {
      await queueChunk(buildChatChunk({
        id: completionId,
        modelId,
        finishReason: 'stop',
      }));
    }

    await streamQueue;
    await LocalApiServerModule?.streamChunk(requestId, 'data: [DONE]\n\n');
    await LocalApiServerModule?.finishStream(requestId);
  }

  private async runLocalCompletion(
    messages: Parameters<typeof localProvider.generate>[0],
    options: Parameters<typeof localProvider.generate>[1],
    hooks?: { onToken?: (token: string) => void; onReasoning?: (content: string) => void },
  ): Promise<CompletionResult> {
    return new Promise<CompletionResult>((resolve, reject) => {
      localProvider.generate(messages, options, {
        onToken: (token) => hooks?.onToken?.(token),
        onReasoning: (content) => hooks?.onReasoning?.(content),
        onComplete: resolve,
        onError: reject,
      }).catch(reject);
    });
  }

  private async handleImageRequest(event: NativeApiRequest): Promise<void> {
    const parsed = parseImageRequest(event.body);
    const store = useAppStore.getState();
    const selectedModelId = parsed.modelId || getDefaultImageModelId(store.downloadedImageModels, store.activeImageModelId);

    if (!selectedModelId) {
      throw new ApiRequestError(400, 'No local image model is selected. Choose one in the app or pass "model".');
    }

    if (!store.downloadedImageModels.some(model => model.id === selectedModelId)) {
      throw new ApiRequestError(404, `Unknown local image model: ${selectedModelId}`);
    }

    await activeModelService.loadImageModel(selectedModelId);
    const settings = useAppStore.getState().settings;
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

    const base64Png = await RNFS.readFile(result.imagePath, 'base64');
    const body = buildImageGenerationResponse({
      base64Png,
      prompt: parsed.prompt,
      responseFormat: parsed.responseFormat,
    });
    await LocalApiServerModule?.respondJson(event.requestId, 200, body, {
      'X-Offgrid-Model': selectedModelId,
    });
  }

  private normalizeError(error: unknown): { status: number; message: string } {
    if (error instanceof ApiRequestError) {
      return { status: error.status, message: error.message };
    }
    if (error instanceof Error) {
      return { status: 500, message: error.message };
    }
    return { status: 500, message: String(error) };
  }

  private async updateStatus(
    nativeStatus: { isRunning: boolean; port: number; listenerReady: boolean },
    lastError: string | null,
  ): Promise<void> {
    const lanIp = nativeStatus.isRunning ? await this.getLanIp() : null;
    const lanEndpoint = lanIp ? `http://${formatHostForUrl(lanIp)}:${nativeStatus.port}` : null;
    const loopbackEndpoint = nativeStatus.isRunning ? buildLoopbackEndpoint(nativeStatus.port) : null;
    const localhostEndpoint = nativeStatus.isRunning ? buildLocalhostEndpoint(nativeStatus.port) : null;
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
