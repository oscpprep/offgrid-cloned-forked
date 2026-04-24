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
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  guidanceScale?: number;
  seed?: number;
  responseFormat: 'b64_json' | 'url';
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

function getContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';

  if (Array.isArray(content)) {
    if (content.some(part => part && typeof part === 'object' && (part as any).type === 'image_url')) {
      throw new ApiRequestError(501, 'Vision inputs are not supported over the LAN API yet');
    }

    return content
      .filter(part => part && typeof part === 'object' && (part as any).type === 'text')
      .map(part => getString((part as any).text))
      .join('\n')
      .trim();
  }

  return '';
}

function toMessageToolCalls(toolCalls: unknown): Message['toolCalls'] {
  if (!Array.isArray(toolCalls)) return undefined;

  const mapped = toolCalls
    .map((toolCall) => {
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
    throw new ApiRequestError(400, 'Request must include a non-empty messages array');
  }

  return input.map((rawMessage, index) => {
    const message = rawMessage as any;
    const role = getString(message?.role) as Message['role'];
    if (!role || !['system', 'user', 'assistant', 'tool'].includes(role)) {
      throw new ApiRequestError(400, `Invalid role at messages[${index}]`);
    }

    const content = getContentText(message?.content);

    if (role !== 'assistant' && role !== 'tool' && !content) {
      throw new ApiRequestError(400, `messages[${index}] must include text content`);
    }

    return {
      id: `api-msg-${index}`,
      role,
      content,
      timestamp: Date.now() + index,
      toolCalls: role === 'assistant' ? toMessageToolCalls(message?.tool_calls) : undefined,
      toolCallId: role === 'tool' ? getString(message?.tool_call_id) || undefined : undefined,
      toolName: role === 'tool' ? getString(message?.name) || undefined : undefined,
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
  const tools = Array.isArray(parsed?.tools) ? parsed.tools as ToolDefinition[] : undefined;

  return {
    modelId: getString(parsed?.model) || undefined,
    stream,
    messages,
    options: {
      temperature: typeof parsed?.temperature === 'number' ? parsed.temperature : undefined,
      maxTokens: typeof parsed?.max_tokens === 'number'
        ? parsed.max_tokens
        : typeof parsed?.max_completion_tokens === 'number'
          ? parsed.max_completion_tokens
          : undefined,
      topP: typeof parsed?.top_p === 'number' ? parsed.top_p : undefined,
      repeatPenalty: typeof parsed?.repeat_penalty === 'number' ? parsed.repeat_penalty : undefined,
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
    prompt,
    negativePrompt: getString(parsed?.negative_prompt || parsed?.negativePrompt) || undefined,
    width,
    height,
    steps: typeof parsed?.steps === 'number' ? parsed.steps : undefined,
    guidanceScale: typeof parsed?.guidance_scale === 'number'
      ? parsed.guidance_scale
      : typeof parsed?.guidanceScale === 'number'
        ? parsed.guidanceScale
        : undefined,
    seed: typeof parsed?.seed === 'number' ? parsed.seed : undefined,
    responseFormat,
  };
}

function toOpenAIToolCalls(toolCalls: ToolCallResult[] | undefined): OpenAIToolCall[] | undefined {
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
          ...(params.reasoningContent ? { reasoning_content: params.reasoningContent } : {}),
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
  });
}

export function buildChatChunk(params: {
  id: string;
  modelId: string;
  delta?: Record<string, unknown>;
  finishReason?: 'stop' | 'tool_calls';
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
  });
}

export function buildImageGenerationResponse(params: {
  base64Png: string;
  prompt: string;
  responseFormat: 'b64_json' | 'url';
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
  });
}

export function buildErrorResponse(message: string): string {
  return JSON.stringify({
    error: {
      message,
    },
  });
}

export function getDefaultTextModelId(textModels: DownloadedModel[], activeModelId: string | null): string | null {
  if (activeModelId && textModels.some(model => model.id === activeModelId)) {
    return activeModelId;
  }
  return textModels[0]?.id ?? null;
}

export function getDefaultImageModelId(imageModels: ONNXImageModel[], activeImageModelId: string | null): string | null {
  if (activeImageModelId && imageModels.some(model => model.id === activeImageModelId)) {
    return activeImageModelId;
  }
  return imageModels[0]?.id ?? null;
}
