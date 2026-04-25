import {
  runLocalCompletion,
  streamLocalChatCompletion,
} from '../../../src/services/localApiServerChat';
import { localProvider } from '../../../src/services/providers/localProvider';

jest.mock('../../../src/services/providers/localProvider', () => ({
  localProvider: {
    generate: jest.fn(),
  },
}));

const mockLocalProvider = localProvider as jest.Mocked<typeof localProvider>;

function createNativeModule() {
  return {
    startStream: jest.fn(
      (
        _requestId: string,
        _statusCode: number,
        _headers?: Record<string, string> | null,
      ) => Promise.resolve(true),
    ),
    streamChunk: jest.fn((_requestId: string, _chunk: string) =>
      Promise.resolve(true),
    ),
    finishStream: jest.fn((_requestId: string) => Promise.resolve(true)),
  };
}

describe('localApiServerChat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('runs local completions through the provider callbacks', async () => {
    mockLocalProvider.generate.mockImplementation(
      async (_messages, _options, callbacks) => {
        callbacks.onToken('Hi');
        callbacks.onComplete({ content: 'Hi' });
      },
    );
    const onToken = jest.fn();

    const result = await runLocalCompletion(
      [{ id: 'm1', role: 'user', content: 'hello', timestamp: 1 }],
      {},
      { onToken },
    );

    expect(onToken).toHaveBeenCalledWith('Hi');
    expect(result.content).toBe('Hi');
  });

  it('streams progress chunks before generated tokens', async () => {
    const nativeModule = createNativeModule();
    mockLocalProvider.generate.mockImplementation(
      async (_messages, _options, callbacks) => {
        callbacks.onToken('A');
        callbacks.onComplete({ content: 'A' });
      },
    );

    const result = await streamLocalChatCompletion({
      nativeModule,
      requestId: 'req-1',
      completionId: 'chatcmpl-1',
      modelId: 'txt-1',
      messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: 1 }],
      options: {},
      prepare: async emitStatus => {
        emitStatus({
          id: 'op-1',
          type: 'chat',
          requestId: 'req-1',
          modelId: 'txt-1',
          stage: 'load_model',
          message: 'loading',
          startedAt: 1,
          updatedAt: 2,
        });
      },
    });

    const chunks = nativeModule.streamChunk.mock.calls
      .map(call => call[1])
      .join('');
    expect(result.ok).toBe(true);
    expect(nativeModule.startStream).toHaveBeenCalledWith(
      'req-1',
      200,
      expect.any(Object),
    );
    expect(chunks).toContain('"stage":"load_model"');
    expect(chunks).toContain('"content":"A"');
    expect(chunks).toContain('[DONE]');
  });

  it('returns a stream error when prepare fails', async () => {
    const nativeModule = createNativeModule();

    const result = await streamLocalChatCompletion({
      nativeModule,
      requestId: 'req-1',
      completionId: 'chatcmpl-1',
      modelId: 'txt-1',
      messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: 1 }],
      options: {},
      prepare: async () => {
        throw new Error('load failed');
      },
    });

    const chunks = nativeModule.streamChunk.mock.calls
      .map(call => call[1])
      .join('');
    expect(result).toEqual({ ok: false, error: 'load failed' });
    expect(chunks).toContain('load failed');
    expect(mockLocalProvider.generate).not.toHaveBeenCalled();
  });
});
