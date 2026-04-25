import {
  ApiOperationTracker,
  ensureApiModelReady,
} from '../../../src/services/localApiServerRuntime';
import { activeModelService } from '../../../src/services/activeModelService';
import { localProvider } from '../../../src/services/providers/localProvider';

jest.mock('../../../src/services/activeModelService', () => ({
  activeModelService: {
    syncWithNativeState: jest.fn(),
    getLoadedModelIds: jest.fn(),
    checkMemoryForDualModel: jest.fn(),
    unloadImageModel: jest.fn(),
    unloadTextModel: jest.fn(),
    loadTextModel: jest.fn(),
    loadImageModel: jest.fn(),
  },
}));

jest.mock('../../../src/services/providers/localProvider', () => ({
  localProvider: {
    loadModel: jest.fn(),
  },
}));

jest.mock('../../../src/utils/logger', () => ({
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockActiveModelService = activeModelService as jest.Mocked<
  typeof activeModelService
>;
const mockLocalProvider = localProvider as jest.Mocked<typeof localProvider>;

describe('localApiServerRuntime', () => {
  let timeoutSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    timeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((
      callback: () => void,
    ) => {
      callback();
      return 0 as any;
    }) as any);
    mockActiveModelService.syncWithNativeState.mockResolvedValue(undefined);
    mockActiveModelService.checkMemoryForDualModel.mockResolvedValue({
      canLoad: true,
      severity: 'safe',
      availableMemoryGB: 8,
      requiredMemoryGB: 2,
      currentlyLoadedMemoryGB: 0,
      totalRequiredMemoryGB: 2,
      remainingAfterLoadGB: 4,
      message: 'safe',
    });
    mockActiveModelService.unloadImageModel.mockResolvedValue(undefined);
    mockActiveModelService.unloadTextModel.mockResolvedValue(undefined);
    mockActiveModelService.loadTextModel.mockResolvedValue(undefined);
    mockActiveModelService.loadImageModel.mockResolvedValue(undefined);
    mockLocalProvider.loadModel.mockResolvedValue(undefined);
  });

  afterEach(() => {
    timeoutSpy.mockRestore();
  });

  it('unloads image model before loading text when dual memory is unsafe', async () => {
    const progress = jest.fn();
    mockActiveModelService.getLoadedModelIds.mockReturnValue({
      textModelId: null,
      imageModelId: 'img-1',
    });
    mockActiveModelService.checkMemoryForDualModel.mockResolvedValue({
      canLoad: false,
      severity: 'critical',
      availableMemoryGB: 3,
      requiredMemoryGB: 5,
      currentlyLoadedMemoryGB: 0,
      totalRequiredMemoryGB: 5,
      remainingAfterLoadGB: -2,
      message: 'Cannot load both models.',
    });

    await ensureApiModelReady({ target: 'text', modelId: 'txt-1', progress });

    expect(mockActiveModelService.unloadImageModel).toHaveBeenCalled();
    expect(mockActiveModelService.loadTextModel).toHaveBeenCalledWith(
      'txt-1',
      300000,
    );
    expect(mockLocalProvider.loadModel).toHaveBeenCalledWith('txt-1');
    expect(progress).toHaveBeenCalledWith(
      'memory_handoff',
      'Cannot load both models.',
      expect.any(Object),
    );
  });

  it('retries image model loading after unloading text on memory-like failures', async () => {
    mockActiveModelService.getLoadedModelIds.mockReturnValue({
      textModelId: 'txt-1',
      imageModelId: null,
    });
    mockActiveModelService.loadImageModel
      .mockRejectedValueOnce(
        new Error('Out of memory while loading image model'),
      )
      .mockResolvedValueOnce(undefined);

    await ensureApiModelReady({ target: 'image', modelId: 'img-1' });

    expect(mockActiveModelService.unloadTextModel).toHaveBeenCalled();
    expect(mockActiveModelService.loadImageModel).toHaveBeenCalledTimes(2);
    expect(mockActiveModelService.loadImageModel).toHaveBeenLastCalledWith(
      'img-1',
      300000,
    );
  });

  it('tracks operation lifecycle snapshots', () => {
    const tracker = new ApiOperationTracker();
    const started = tracker.start({
      type: 'chat',
      requestId: 'req-1',
      modelId: 'txt-1',
      stage: 'accepted',
      message: 'accepted',
    });
    const updated = tracker.update('load_model', 'loading');
    const completed = tracker.complete('done');

    expect(started.id).toBeTruthy();
    expect(updated?.stage).toBe('load_model');
    expect(completed?.complete).toBe(true);
    expect(tracker.snapshot().last?.message).toBe('done');
  });
});
