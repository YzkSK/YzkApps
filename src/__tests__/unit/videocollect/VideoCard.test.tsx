// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoCard } from '@/app/videocollect/views/VideoCard';
import type { DriveFile } from '@/app/videocollect/constants';

vi.mock('@/app/auth/AuthContext', () => ({
  useAuth: () => ({
    currentUser: {
      uid: 'user-1',
      getIdToken: vi.fn().mockResolvedValue('id-token'),
    },
  }),
}));

const baseFile: DriveFile = {
  id: 'video-1',
  name: 'sample.mp4',
  mimeType: 'video/mp4',
  size: '1000',
  modifiedTime: '2026-01-01T00:00:00.000Z',
};

const originalCurrentTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');

function renderCard(file: DriveFile) {
  const onPreviewChange = vi.fn();

  function Harness() {
    const [previewingId, setPreviewingId] = useState<string | null>(null);
    const handlePreviewChange = (id: string | null) => {
      onPreviewChange(id);
      setPreviewingId(id);
    };

    return (
      <VideoCard
        file={file}
        tags={[]}
        accessToken="access-token"
        isPreviewing={file.id === previewingId}
        isPlaying={false}
        onPreviewChange={handlePreviewChange}
        onTagEdit={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />
    );
  }

  const view = render(
    <MemoryRouter>
      <Harness />
    </MemoryRouter>,
  );

  return { ...view, onPreviewChange };
}

describe('VideoCard preview', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalCurrentTime) {
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', originalCurrentTime);
    }
  });

  it('uses media duration for varied preview clips when Drive metadata has no duration', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ nonce: 'nonce-1' }),
    }));
    const currentTimes: number[] = [];
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      get() {
        return originalCurrentTime?.get?.call(this) ?? 0;
      },
      set(value: number) {
        currentTimes.push(value);
        originalCurrentTime?.set?.call(this, value);
      },
    });

    const { onPreviewChange } = renderCard(baseFile);

    fireEvent.click(screen.getByText('sample.mp4').closest('.vc-card')!);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onPreviewChange).toHaveBeenCalledWith('video-1');

    const video = document.querySelector('video') as HTMLVideoElement;
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.2)
      .mockReturnValueOnce(0.3)
      .mockReturnValueOnce(0.4);
    Object.defineProperty(video, 'duration', { configurable: true, value: 60 });
    fireEvent.loadedMetadata(video);

    for (let i = 0; i < 3; i += 1) {
      fireEvent.canPlay(video);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
    }

    expect(currentTimes.slice(0, 4)).toEqual([5.5, 11, 16.5, 22]);
  });

  it('waits until the preview clip is ready before counting clip duration', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ nonce: 'nonce-1' }),
    }));
    const currentTimes: number[] = [];
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      get() {
        return originalCurrentTime?.get?.call(this) ?? 0;
      },
      set(value: number) {
        currentTimes.push(value);
        originalCurrentTime?.set?.call(this, value);
      },
    });

    renderCard({
      ...baseFile,
      videoMediaMetadata: { durationMillis: '60000' },
    });

    fireEvent.click(screen.getByText('sample.mp4').closest('.vc-card')!);
    await act(async () => {
      await Promise.resolve();
    });

    const video = document.querySelector('video') as HTMLVideoElement;
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.2)
      .mockReturnValueOnce(0.3)
      .mockReturnValueOnce(0.4);
    Object.defineProperty(video, 'duration', { configurable: true, value: 60 });
    fireEvent.loadedMetadata(video);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(currentTimes).toEqual([5.5]);

    fireEvent.canPlay(video);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(currentTimes).toEqual([5.5, 11]);
  });
});
