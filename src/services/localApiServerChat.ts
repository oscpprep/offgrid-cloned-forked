import type { Message } from '../types';
import {
  buildChatChunk,
  normalizeApiError,
  type ApiOperationStatus,
} from './localApiServerHelpers';
import { localProvider } from './providers/localProvider';
import type { CompletionResult, GenerationOptions } from './providers';

type NativeStreamModule = {
  startStream: (
    requestId: string,
    statusCode: number,
    headers?: Record<string, string> | null,
  ) => Promise<boolean>;
  streamChunk: (requestId: string, chunk: string) => Promise<boolean>;
  finishStream: (requestId: string) => Promise<boolean>;
};

type StreamProgressCallback = (status: ApiOperationStatus) => void;

const STREAM_HEADERS = {
  'X-Offgrid-Api-Version': '1',
};

export async function runLocalCompletion(
  messages: Message[],
  options: GenerationOptions,
  hooks?: {
    onToken?: (token: string) => void;
    onReasoning?: (content: string) => void;
  },
): Promise<CompletionResult> {
  return new Promise<CompletionResult>((resolve, reject) => {
    localProvider
      .generate(messages, options, {
        onToken: token => hooks?.onToken?.(token),
        onReasoning: content => hooks?.onReasoning?.(content),
        onComplete: resolve,
        onError: reject,
      })
      .catch(reject);
  });
}

export async function streamLocalChatCompletion(params: {
  nativeModule: NativeStreamModule;
  requestId: string;
  completionId: string;
  modelId: string;
  messages: Message[];
  options: GenerationOptions;
  prepare: (emitStatus: StreamProgressCallback) => Promise<void>;
}): Promise<{ ok: boolean; error?: string }> {
  const {
    nativeModule,
    requestId,
    completionId,
    modelId,
    messages,
    options,
    prepare,
  } = params;
  await nativeModule.startStream(requestId, 200, {
    ...STREAM_HEADERS,
    'X-Offgrid-Model': modelId,
  });

  let streamQueue = Promise.resolve();
  const queueChunk = (payload: string) => {
    streamQueue = streamQueue
      .then(() => nativeModule.streamChunk(requestId, `data: ${payload}\n\n`))
      .then(() => undefined);
    return streamQueue;
  };
  const emitStatus = (status: ApiOperationStatus) => {
    queueChunk(
      buildChatChunk({
        id: completionId,
        modelId,
        delta: {},
        offgrid: { operation: status },
      }),
    );
  };
  const closeStream = async () => {
    await streamQueue;
    await nativeModule.streamChunk(requestId, 'data: [DONE]\n\n');
    await nativeModule.finishStream(requestId);
  };

  await queueChunk(
    buildChatChunk({
      id: completionId,
      modelId,
      delta: { role: 'assistant' },
    }),
  );

  try {
    await prepare(emitStatus);
  } catch (error) {
    const { message } = normalizeApiError(error);
    await queueChunk(JSON.stringify({ error: { message } }));
    await closeStream();
    return { ok: false, error: message };
  }

  let result: CompletionResult;
  try {
    result = await runLocalCompletion(messages, options, {
      onToken: token => {
        queueChunk(
          buildChatChunk({
            id: completionId,
            modelId,
            delta: { content: token },
          }),
        );
      },
      onReasoning: reasoningContent => {
        queueChunk(
          buildChatChunk({
            id: completionId,
            modelId,
            delta: { reasoning_content: reasoningContent },
          }),
        );
      },
    });
  } catch (error) {
    const { message } = normalizeApiError(error);
    await queueChunk(JSON.stringify({ error: { message } }));
    await closeStream();
    return { ok: false, error: message };
  }

  if (result.toolCalls?.length) {
    await queueChunk(
      buildChatChunk({
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
      }),
    );
  } else {
    await queueChunk(
      buildChatChunk({
        id: completionId,
        modelId,
        finishReason: 'stop',
      }),
    );
  }

  await closeStream();
  return { ok: true };
}
