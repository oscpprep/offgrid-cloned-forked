/* eslint-disable max-lines */
import type { DownloadedModel, Message, ONNXImageModel } from '../types';
import type { ToolDefinition, ToolCallResult } from './providers';

export class ApiRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

export interface NativeApiRequest {
  requestId: string;
  method: string;
  path: string;
  body: string;
}

export interface ParsedChatRequest {
  modelId?: string;
  unloadOther?: boolean;
  stream: boolean;
  messages: Message[];
  options: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    repeatPenalty?: number;
    tools?: ToolDefinition[];
  };
}

export interface ParsedImageRequest {
  modelId?: string;
  unloadOther?: boolean;
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  guidanceScale?: number;
  seed?: number;
  responseFormat: 'b64_json' | 'url';
}

export type ApiUnloadTarget = 'text' | 'image' | 'all';
export type ApiControlTarget = ApiUnloadTarget;

export interface ApiOperationStatus {
  id: string;
  type:
    | 'chat'
    | 'image'
    | 'unload'
    | 'load'
    | 'reload'
    | 'stop'
    | 'cache'
    | 'gallery'
    | 'settings'
    | 'server'
    | 'storage'
    | 'download'
    | 'delete';
  requestId: string;
  modelId?: string;
  stage: string;
  message: string;
  startedAt: number;
  updatedAt: number;
  complete?: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

export interface ParsedModelControlRequest {
  target?: ApiControlTarget;
  modelId?: string;
  force: boolean;
  unloadOther: boolean;
}

export interface ParsedStopRequest {
  target: ApiControlTarget;
  force: boolean;
}

export interface ParsedCacheClearRequest {
  target: ApiControlTarget;
  clearData: boolean;
}

export interface ParsedGalleryDeleteRequest {
  ids: string[];
  conversationId?: string;
  all: boolean;
}

export interface ParsedDownloadCancelRequest {
  downloadId: number;
}

type OpenAIToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

const MODEL_OWNER = 'offgrid-local';

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseJsonObject(body: string): Record<string, any> {
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

function getOptionalBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function normalizeTarget(value: unknown): ApiControlTarget | undefined {
  const target = getString(value).toLowerCase();
  if (!target || target === '*') return undefined;
  if (['text', 'llm', 'chat', 'language'].includes(target)) return 'text';
  if (['image', 'images', 'vision', 'diffusion'].includes(target)) {
    return 'image';
  }
  if (target === 'all') return 'all';
  throw new ApiRequestError(
    400,
    'target must be one of "text", "image", or "all"',
  );
}

function getPathTarget(path: string, action: string): ApiControlTarget | undefined {
  return normalizeTarget(
    path.match(new RegExp(`^/v1/${action}/(text|image|all)$`))?.[1] ||
      path.match(new RegExp(`^/v1/models/${action}/(text|image|all)$`))?.[1] ||
      path.match(new RegExp(`^/v1/cache/clear/(text|image|all)$`))?.[1] ||
      path.match(new RegExp(`^/v1/generation/(?:stop|cancel)/(text|image|all)$`))?.[1],
  );
}

function getContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';

  if (Array.isArray(content)) {
    if (
      content.some(
        part =>
          part &&
          typeof part === 'object' &&
          (part as any).type === 'image_url',
      )
    ) {
      throw new ApiRequestError(
        501,
        'Vision inputs are not supported over the LAN API yet',
      );
    }

    return content
      .filter(
        part =>
          part && typeof part === 'object' && (part as any).type === 'text',
      )
      .map(part => getString((part as any).text))
      .join('\n')
      .trim();
  }

  return '';
}

function toMessageToolCalls(toolCalls: unknown): Message['toolCalls'] {
  if (!Array.isArray(toolCalls)) return undefined;

  const mapped = toolCalls
    .map(toolCall => {
      const call = toolCall as any;
      const name = getString(call?.function?.name);
      const args = call?.function?.arguments;
      if (!name) return null;
      return {
        id: getString(call?.id) || undefined,
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args || {}),
      };
    })
    .filter(Boolean) as NonNullable<Message['toolCalls']>;

  return mapped.length > 0 ? mapped : undefined;
}

function parseMessages(input: unknown): Message[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ApiRequestError(
      400,
      'Request must include a non-empty messages array',
    );
  }

  return input.map((rawMessage, index) => {
    const message = rawMessage as any;
    const role = getString(message?.role) as Message['role'];
    if (!role || !['system', 'user', 'assistant', 'tool'].includes(role)) {
      throw new ApiRequestError(400, `Invalid role at messages[${index}]`);
    }

    const content = getContentText(message?.content);

    if (role !== 'assistant' && role !== 'tool' && !content) {
      throw new ApiRequestError(
        400,
        `messages[${index}] must include text content`,
      );
    }

    return {
      id: `api-msg-${index}`,
      role,
      content,
      timestamp: Date.now() + index,
      toolCalls:
        role === 'assistant'
          ? toMessageToolCalls(message?.tool_calls)
          : undefined,
      toolCallId:
        role === 'tool'
          ? getString(message?.tool_call_id) || undefined
          : undefined,
      toolName:
        role === 'tool' ? getString(message?.name) || undefined : undefined,
    };
  });
}

export function parseChatRequest(body: string): ParsedChatRequest {
  let parsed: any;
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    throw new ApiRequestError(400, 'Request body must be valid JSON');
  }

  const messages = parseMessages(parsed?.messages);
  const stream = Boolean(parsed?.stream);
  const tools = Array.isArray(parsed?.tools)
    ? (parsed.tools as ToolDefinition[])
    : undefined;

  return {
    modelId: getString(parsed?.model) || undefined,
    unloadOther: getOptionalBoolean(parsed?.unload_other, parsed?.unloadOther),
    stream,
    messages,
    options: {
      temperature:
        typeof parsed?.temperature === 'number'
          ? parsed.temperature
          : undefined,
      maxTokens:
        typeof parsed?.max_tokens === 'number'
          ? parsed.max_tokens
          : typeof parsed?.max_completion_tokens === 'number'
          ? parsed.max_completion_tokens
          : undefined,
      topP: typeof parsed?.top_p === 'number' ? parsed.top_p : undefined,
      repeatPenalty:
        typeof parsed?.repeat_penalty === 'number'
          ? parsed.repeat_penalty
          : undefined,
      tools,
    },
  };
}

function parseImageSize(size: unknown): { width?: number; height?: number } {
  if (typeof size !== 'string' || !size.trim()) return {};
  const match = size.match(/^(\d+)x(\d+)$/);
  if (!match) {
    throw new ApiRequestError(400, 'size must use the format "512x512"');
  }
  return {
    width: Number.parseInt(match[1], 10),
    height: Number.parseInt(match[2], 10),
  };
}

export function parseImageRequest(body: string): ParsedImageRequest {
  let parsed: any;
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    throw new ApiRequestError(400, 'Request body must be valid JSON');
  }

  const prompt = getString(parsed?.prompt).trim();
  if (!prompt) {
    throw new ApiRequestError(400, 'prompt is required');
  }
  if (parsed?.n && parsed.n !== 1) {
    throw new ApiRequestError(400, 'Only n=1 is supported');
  }

  const { width, height } = parseImageSize(parsed?.size);
  const responseFormat = parsed?.response_format === 'url' ? 'url' : 'b64_json';

  return {
    modelId: getString(parsed?.model) || undefined,
    unloadOther: getOptionalBoolean(parsed?.unload_other, parsed?.unloadOther),
    prompt,
    negativePrompt:
      getString(parsed?.negative_prompt || parsed?.negativePrompt) || undefined,
    width,
    height,
    steps: typeof parsed?.steps === 'number' ? parsed.steps : undefined,
    guidanceScale:
      typeof parsed?.guidance_scale === 'number'
        ? parsed.guidance_scale
        : typeof parsed?.guidanceScale === 'number'
        ? parsed.guidanceScale
        : undefined,
    seed: typeof parsed?.seed === 'number' ? parsed.seed : undefined,
    responseFormat,
  };
}

export function parseUnloadRequest(
  body: string,
  path = '/v1/models/unload',
): ApiUnloadTarget {
  const pathTarget = path.match(
    /^\/v1\/models\/unload\/(text|image|all)$/,
  )?.[1];
  if (pathTarget === 'text' || pathTarget === 'image' || pathTarget === 'all') {
    return pathTarget;
  }

  let parsed: any = {};
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    throw new ApiRequestError(400, 'Request body must be valid JSON');
  }

  const target = getString(
    parsed?.target || parsed?.type || parsed?.model,
  ).toLowerCase();
  if (!target || target === '*') return 'all';
  if (['text', 'llm', 'chat'].includes(target)) return 'text';
  if (['image', 'images', 'vision'].includes(target)) return 'image';
  if (target === 'all') return 'all';
  throw new ApiRequestError(
    400,
    'target must be one of "text", "image", or "all"',
  );
}

export function parseModelControlRequest(
  body: string,
  path: string,
  action: 'load' | 'reload' | 'delete',
): ParsedModelControlRequest {
  const parsed = parseJsonObject(body);
  const target =
    getPathTarget(path, action) ||
    normalizeTarget(parsed.target || parsed.type || parsed.model_type);

  return {
    target,
    modelId:
      getString(parsed.model || parsed.model_id || parsed.id).trim() ||
      undefined,
    force: Boolean(parsed.force),
    unloadOther: parsed.unload_other !== false && parsed.unloadOther !== false,
  };
}

export function parseStopRequest(body: string, path: string): ParsedStopRequest {
  const parsed = parseJsonObject(body);
  return {
    target:
      getPathTarget(path, 'generation/(?:stop|cancel)') ||
      normalizeTarget(parsed.target || parsed.type) ||
      'all',
    force: parsed.force !== false,
  };
}

export function parseCacheClearRequest(
  body: string,
  path: string,
): ParsedCacheClearRequest {
  const parsed = parseJsonObject(body);
  return {
    target:
      getPathTarget(path, 'cache/clear') ||
      normalizeTarget(parsed.target || parsed.type) ||
      'text',
    clearData: Boolean(parsed.clear_data || parsed.clearData),
  };
}

export function parseGalleryDeleteRequest(
  body: string,
  path: string,
): ParsedGalleryDeleteRequest {
  const parsed = parseJsonObject(body);
  const pathId = path.match(/^\/v1\/gallery\/images\/([^/]+)$/)?.[1];
  const ids = new Set<string>();
  if (pathId) ids.add(decodeURIComponent(pathId));
  const rawIds = Array.isArray(parsed.ids) ? parsed.ids : [parsed.id];
  rawIds
    .map(id => getString(id).trim())
    .filter(Boolean)
    .forEach(id => ids.add(id));

  return {
    ids: Array.from(ids),
    conversationId:
      getString(parsed.conversation_id || parsed.conversationId).trim() ||
      undefined,
    all: Boolean(parsed.all || parsed.target === 'all'),
  };
}

export function parseDownloadCancelRequest(
  body: string,
  path: string,
): ParsedDownloadCancelRequest {
  const parsed = parseJsonObject(body);
  const pathId = path.match(/^\/v1\/downloads\/cancel\/(\d+)$/)?.[1];
  const downloadId = Number.parseInt(
    pathId || getString(parsed.download_id || parsed.downloadId || parsed.id),
    10,
  );
  if (!Number.isFinite(downloadId) || downloadId <= 0) {
    throw new ApiRequestError(400, 'download_id must be a positive number');
  }
  return { downloadId };
}

export function parseSettingsPatchRequest(body: string): Record<string, unknown> {
  const parsed = parseJsonObject(body);
  const settings =
    parsed.settings && typeof parsed.settings === 'object'
      ? parsed.settings
      : parsed;
  return { ...settings };
}

function toOpenAIToolCalls(
  toolCalls: ToolCallResult[] | undefined,
): OpenAIToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;

  return toolCalls.map((toolCall, index) => ({
    id: toolCall.id || `call_${index + 1}`,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments: toolCall.arguments,
    },
  }));
}

export function buildModelsResponse(
  textModels: DownloadedModel[],
  imageModels: ONNXImageModel[],
): string {
  const now = Math.floor(Date.now() / 1000);
  const data = [
    ...textModels.map(model => ({
      id: model.id,
      object: 'model',
      created: now,
      owned_by: MODEL_OWNER,
      type: model.isVisionModel ? 'vision' : 'text',
      metadata: {
        quantization: model.quantization,
        filename: model.fileName,
      },
    })),
    ...imageModels.map(model => ({
      id: model.id,
      object: 'model',
      created: now,
      owned_by: MODEL_OWNER,
      type: 'image',
      metadata: {
        backend: model.backend || 'unknown',
        style: model.style || '',
      },
    })),
  ];

  return JSON.stringify({ object: 'list', data });
}

export function buildChatCompletionResponse(params: {
  id: string;
  modelId: string;
  content: string;
  reasoningContent?: string;
  toolCalls?: ToolCallResult[];
  finishReason: 'stop' | 'tool_calls';
  completionTokens?: number;
  offgrid?: Record<string, unknown>;
}): string {
  const openAIToolCalls = toOpenAIToolCalls(params.toolCalls);

  return JSON.stringify({
    id: params.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: params.modelId,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: params.content,
          ...(params.reasoningContent
            ? { reasoning_content: params.reasoningContent }
            : {}),
          ...(openAIToolCalls ? { tool_calls: openAIToolCalls } : {}),
        },
        finish_reason: params.finishReason,
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: params.completionTokens || 0,
      total_tokens: params.completionTokens || 0,
    },
    ...(params.offgrid ? { offgrid: params.offgrid } : {}),
  });
}

export function buildChatChunk(params: {
  id: string;
  modelId: string;
  delta?: Record<string, unknown>;
  finishReason?: 'stop' | 'tool_calls';
  offgrid?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    id: params.id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: params.modelId,
    choices: [
      {
        index: 0,
        delta: params.delta || {},
        finish_reason: params.finishReason ?? null,
      },
    ],
    ...(params.offgrid ? { offgrid: params.offgrid } : {}),
  });
}

export function buildImageGenerationResponse(params: {
  base64Png: string;
  prompt: string;
  responseFormat: 'b64_json' | 'url';
  offgrid?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    created: Math.floor(Date.now() / 1000),
    data: [
      params.responseFormat === 'url'
        ? {
            url: `data:image/png;base64,${params.base64Png}`,
            revised_prompt: params.prompt,
          }
        : {
            b64_json: params.base64Png,
            revised_prompt: params.prompt,
          },
    ],
    ...(params.offgrid ? { offgrid: params.offgrid } : {}),
  });
}

export function buildErrorResponse(
  message: string,
  params?: { status?: number; operation?: ApiOperationStatus | null },
): string {
  return JSON.stringify({
    error: {
      message,
      ...(params?.status ? { status: params.status } : {}),
    },
    ...(params?.operation ? { offgrid: { operation: params.operation } } : {}),
  });
}

export function buildUnloadResponse(params: {
  target: ApiUnloadTarget;
  textUnloaded: boolean;
  imageUnloaded: boolean;
  loadedModels: { textModelId: string | null; imageModelId: string | null };
  operation?: ApiOperationStatus | null;
}): string {
  return JSON.stringify({
    object: 'offgrid.unload',
    target: params.target,
    unloaded: {
      text: params.textUnloaded,
      image: params.imageUnloaded,
    },
    loaded_models: {
      text: params.loadedModels.textModelId,
      image: params.loadedModels.imageModelId,
    },
    ...(params.operation ? { offgrid: { operation: params.operation } } : {}),
  });
}

export function buildStatusResponse(params: {
  server: Record<string, unknown>;
  modelCounts: { text: number; image: number };
  activeModels: { textModelId: string | null; imageModelId: string | null };
  loadedModels: { textModelId: string | null; imageModelId: string | null };
  operation: {
    current: ApiOperationStatus | null;
    last: ApiOperationStatus | null;
  };
  resourceUsage?: Record<string, unknown> | null;
  runtime?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    object: 'offgrid.status',
    server: params.server,
    models: {
      counts: params.modelCounts,
      active: {
        text: params.activeModels.textModelId,
        image: params.activeModels.imageModelId,
      },
      loaded: {
        text: params.loadedModels.textModelId,
        image: params.loadedModels.imageModelId,
      },
    },
    operation: params.operation,
    resource_usage: params.resourceUsage ?? null,
    runtime: params.runtime ?? null,
  });
}

export function buildActionResponse(params: {
  object: string;
  ok?: boolean;
  data?: Record<string, unknown>;
  operation?: ApiOperationStatus | null;
}): string {
  return JSON.stringify({
    object: params.object,
    ok: params.ok ?? true,
    ...(params.data || {}),
    ...(params.operation ? { offgrid: { operation: params.operation } } : {}),
  });
}

export function buildCapabilitiesResponse(): string {
  return JSON.stringify({
    object: 'offgrid.capabilities',
    endpoints: {
      openai: [
        'GET /v1/models',
        'POST /v1/chat/completions',
        'POST /v1/images/generations',
      ],
      management: [
        'GET /v1/status',
        'GET /v1/capabilities',
        'GET /v1/settings',
        'POST /v1/settings',
        'POST /v1/models/load[/text|image]',
        'POST /v1/models/reload[/text|image|all]',
        'POST /v1/models/unload[/text|image|all]',
        'POST /v1/models/delete[/text|image]',
        'POST /v1/generation/stop[/text|image|all]',
        'POST /v1/cache/clear[/text|image|all]',
        'GET /v1/gallery/images',
        'POST /v1/gallery/delete',
        'DELETE /v1/gallery/images/{id}',
        'GET /v1/downloads',
        'POST /v1/downloads/cancel/{downloadId}',
        'GET /v1/storage',
        'POST /v1/storage/scan',
        'POST /v1/storage/orphans/delete',
        'POST /v1/server/reload',
        'POST /v1/server/restart',
        'POST /v1/server/stop',
      ],
    },
  });
}

export function normalizeApiError(error: unknown): {
  status: number;
  message: string;
} {
  if (error instanceof ApiRequestError) {
    return { status: error.status, message: error.message };
  }
  if (error instanceof Error) {
    return { status: 500, message: error.message };
  }
  return { status: 500, message: String(error) };
}

export function getDefaultTextModelId(
  textModels: DownloadedModel[],
  activeModelId: string | null,
): string | null {
  if (activeModelId && textModels.some(model => model.id === activeModelId)) {
    return activeModelId;
  }
  return textModels[0]?.id ?? null;
}

export function getDefaultImageModelId(
  imageModels: ONNXImageModel[],
  activeImageModelId: string | null,
): string | null {
  if (
    activeImageModelId &&
    imageModels.some(model => model.id === activeImageModelId)
  ) {
    return activeImageModelId;
  }
  return imageModels[0]?.id ?? null;
}
