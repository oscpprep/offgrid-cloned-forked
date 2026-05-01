import {
  ApiRequestError,
  buildChatCompletionResponse,
  buildImageGenerationResponse,
  buildModelsResponse,
  buildStatusResponse,
  buildUnloadResponse,
  buildActionResponse,
  buildCapabilitiesResponse,
  getDefaultImageModelId,
  getDefaultTextModelId,
  parseCacheClearRequest,
  parseChatRequest,
  parseDownloadCancelRequest,
  parseGalleryDeleteRequest,
  parseImageRequest,
  parseModelControlRequest,
  parseSettingsPatchRequest,
  parseStopRequest,
  parseUnloadRequest,
} from '../../../src/services/localApiServerHelpers';

describe('localApiServerHelpers', () => {
  describe('parseChatRequest', () => {
    it('parses OpenAI chat payloads into app messages and options', () => {
      const parsed = parseChatRequest(JSON.stringify({
        model: 'qwen-local',
        stream: true,
        unload_other: false,
        temperature: 0.4,
        max_tokens: 222,
        top_p: 0.8,
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                function: {
                  name: 'calculator',
                  arguments: '{"expression":"2+2"}',
                },
              },
            ],
          },
          { role: 'tool', content: '4', tool_call_id: 'call_1', name: 'calculator' },
        ],
      }));

      expect(parsed.modelId).toBe('qwen-local');
      expect(parsed.stream).toBe(true);
      expect(parsed.unloadOther).toBe(false);
      expect(parsed.options).toMatchObject({
        temperature: 0.4,
        maxTokens: 222,
        topP: 0.8,
      });
      expect(parsed.messages).toHaveLength(4);
      expect(parsed.messages[2].toolCalls?.[0]).toEqual({
        id: 'call_1',
        name: 'calculator',
        arguments: '{"expression":"2+2"}',
      });
      expect(parsed.messages[3].toolCallId).toBe('call_1');
      expect(parsed.messages[3].toolName).toBe('calculator');
    });

    it('rejects image inputs for chat payloads', () => {
      expect(() => parseChatRequest(JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
            ],
          },
        ],
      }))).toThrow(ApiRequestError);
    });
  });

  describe('parseImageRequest', () => {
    it('parses custom image generation fields', () => {
      const parsed = parseImageRequest(JSON.stringify({
        model: 'dreamshaper',
        prompt: 'A mountain at sunrise',
        negative_prompt: 'low quality',
        size: '512x512',
        steps: 16,
        guidance_scale: 6,
        seed: 7,
        response_format: 'url',
        unloadOther: true,
      }));

      expect(parsed).toEqual({
        modelId: 'dreamshaper',
        unloadOther: true,
        prompt: 'A mountain at sunrise',
        negativePrompt: 'low quality',
        width: 512,
        height: 512,
        steps: 16,
        guidanceScale: 6,
        seed: 7,
        responseFormat: 'url',
      });
    });

    it('rejects multi-image requests', () => {
      expect(() => parseImageRequest(JSON.stringify({
        prompt: 'test',
        n: 2,
      }))).toThrow('Only n=1 is supported');
    });
  });


  describe('parseUnloadRequest', () => {
    it('parses unload targets from body and path aliases', () => {
      expect(parseUnloadRequest(JSON.stringify({ target: 'llm' }))).toBe('text');
      expect(parseUnloadRequest(JSON.stringify({ type: 'vision' }))).toBe('image');
      expect(parseUnloadRequest('', '/v1/models/unload/all')).toBe('all');
      expect(parseUnloadRequest('{}')).toBe('all');
    });

    it('rejects invalid unload targets', () => {
      expect(() => parseUnloadRequest(JSON.stringify({ target: 'audio' }))).toThrow(ApiRequestError);
    });
  });

  describe('management request parsers', () => {
    it('parses model load/reload/delete control payloads and path targets', () => {
      expect(parseModelControlRequest(JSON.stringify({ model: 'txt-1' }), '/v1/models/load/text', 'load')).toEqual({
        target: 'text',
        modelId: 'txt-1',
        force: false,
        unloadOther: true,
      });
      expect(parseModelControlRequest(JSON.stringify({ target: 'vision', model_id: 'img-1', unload_other: false }), '/v1/models/reload', 'reload')).toMatchObject({
        target: 'image',
        modelId: 'img-1',
        unloadOther: false,
      });
    });

    it('parses stop, cache, gallery, download, and settings management requests', () => {
      expect(parseStopRequest('', '/v1/generation/stop/all')).toEqual({
        target: 'all',
        force: true,
      });
      expect(parseCacheClearRequest(JSON.stringify({ clear_data: true }), '/v1/cache/clear/text')).toEqual({
        target: 'text',
        clearData: true,
      });
      expect(parseGalleryDeleteRequest(JSON.stringify({ ids: ['a', 'b'] }), '/v1/gallery/delete')).toEqual({
        ids: ['a', 'b'],
        conversationId: undefined,
        all: false,
      });
      expect(parseGalleryDeleteRequest('', '/v1/gallery/images/image%201')).toMatchObject({
        ids: ['image 1'],
      });
      expect(parseDownloadCancelRequest('', '/v1/downloads/cancel/42')).toEqual({
        downloadId: 42,
      });
      expect(parseSettingsPatchRequest(JSON.stringify({ settings: { temperature: 0.2 } }))).toEqual({
        temperature: 0.2,
      });
    });

    it('rejects invalid management payloads', () => {
      expect(() => parseStopRequest('[]', '/v1/generation/stop')).toThrow(ApiRequestError);
      expect(() => parseDownloadCancelRequest('{}', '/v1/downloads/cancel')).toThrow(ApiRequestError);
      expect(() => parseCacheClearRequest(JSON.stringify({ target: 'audio' }), '/v1/cache/clear')).toThrow(ApiRequestError);
    });
  });

  describe('response builders', () => {
    it('builds a models list that includes text and image models', () => {
      const payload = JSON.parse(buildModelsResponse(
        [
          {
            id: 'text-1',
            name: 'Text 1',
            author: 'me',
            filePath: '/model.gguf',
            fileName: 'model.gguf',
            fileSize: 1,
            quantization: 'Q4_K_M',
            downloadedAt: 'now',
          },
        ],
        [
          {
            id: 'img-1',
            name: 'Image 1',
            description: 'desc',
            modelPath: '/img',
            downloadedAt: 'now',
            size: 1,
            backend: 'mnn',
          },
        ],
      ));

      expect(payload.object).toBe('list');
      expect(payload.data).toHaveLength(2);
      expect(payload.data[0].type).toBe('text');
      expect(payload.data[1].type).toBe('image');
    });

    it('builds a chat completion with tool calls', () => {
      const payload = JSON.parse(buildChatCompletionResponse({
        id: 'chatcmpl-1',
        modelId: 'text-1',
        content: 'Done',
        toolCalls: [{ id: 'call_1', name: 'calculator', arguments: '{"expression":"2+2"}' }],
        finishReason: 'tool_calls',
      }));

      expect(payload.choices[0].message.tool_calls[0].function.name).toBe('calculator');
      expect(payload.choices[0].finish_reason).toBe('tool_calls');
    });

    it('builds image responses for b64 and url formats', () => {
      const b64 = JSON.parse(buildImageGenerationResponse({
        base64Png: 'abc123',
        prompt: 'cat',
        responseFormat: 'b64_json',
      }));
      const url = JSON.parse(buildImageGenerationResponse({
        base64Png: 'abc123',
        prompt: 'cat',
        responseFormat: 'url',
      }));

      expect(b64.data[0].b64_json).toBe('abc123');
      expect(url.data[0].url).toContain('data:image/png;base64,abc123');
    });


    it('builds status and unload responses with operation details', () => {
      const operation = {
        id: 'op-1',
        type: 'unload' as const,
        requestId: 'req-1',
        stage: 'complete',
        message: 'done',
        startedAt: 1,
        updatedAt: 2,
        complete: true,
      };
      const status = JSON.parse(buildStatusResponse({
        server: { isRunning: true, port: 3333 },
        modelCounts: { text: 1, image: 1 },
        activeModels: { textModelId: 'txt', imageModelId: 'img' },
        loadedModels: { textModelId: null, imageModelId: 'img' },
        operation: { current: null, last: operation },
        resourceUsage: { memoryUsagePercent: 77 },
        runtime: { text_generation: { is_generating: false } },
      }));
      const unload = JSON.parse(buildUnloadResponse({
        target: 'image',
        textUnloaded: false,
        imageUnloaded: true,
        loadedModels: { textModelId: null, imageModelId: null },
        operation,
      }));

      expect(status.object).toBe('offgrid.status');
      expect(status.operation.last.id).toBe('op-1');
      expect(status.runtime.text_generation.is_generating).toBe(false);
      expect(unload.object).toBe('offgrid.unload');
      expect(unload.unloaded.image).toBe(true);
      expect(unload.offgrid.operation.stage).toBe('complete');
    });

    it('builds generic management action and capability responses', () => {
      const action = JSON.parse(buildActionResponse({
        object: 'offgrid.test',
        data: { value: 1 },
      }));
      const capabilities = JSON.parse(buildCapabilitiesResponse());

      expect(action.object).toBe('offgrid.test');
      expect(action.ok).toBe(true);
      expect(action.value).toBe(1);
      expect(capabilities.endpoints.management).toContain('POST /v1/models/load[/text|image]');
    });
  });

  describe('default model selection', () => {
    it('prefers the active model when it exists', () => {
      expect(getDefaultTextModelId([{ id: 'a' } as any, { id: 'b' } as any], 'b')).toBe('b');
      expect(getDefaultImageModelId([{ id: 'x' } as any, { id: 'y' } as any], 'y')).toBe('y');
    });

    it('falls back to the first downloaded model', () => {
      expect(getDefaultTextModelId([{ id: 'a' } as any, { id: 'b' } as any], null)).toBe('a');
      expect(getDefaultImageModelId([{ id: 'x' } as any, { id: 'y' } as any], null)).toBe('x');
    });
  });
});
