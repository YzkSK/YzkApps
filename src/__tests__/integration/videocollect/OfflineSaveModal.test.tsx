// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OfflineSaveModal } from '@/app/videocollect/modals/OfflineSaveModal';

vi.mock('@/app/videocollect/offlineStorage', () => ({
  getOfflineStorageUsage: vi.fn().mockResolvedValue({ count: 2, totalBytes: 500 * 1024 * 1024 }),
  getStorageLimitGb: vi.fn().mockReturnValue(5),
  checkQuota: vi.fn().mockResolvedValue('ok'),
}));

vi.mock('@/app/videocollect/downloadQueue', () => ({
  startDownload: vi.fn(),
}));

const defaultProps = {
  fileId: 'file1',
  fileName: 'test.mp4',
  fileSize: '10000000',
  proxyUrl: 'https://proxy.example.com',
  accessToken: 'token',
  onClose: vi.fn(),
  addToast: vi.fn(),
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OfflineSaveModal', () => {
  it('ストレージ使用量とファイルサイズを表示する', async () => {
    render(<OfflineSaveModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/ストレージ使用量/)).toBeTruthy();
      expect(screen.getByText(/ファイルサイズ/)).toBeTruthy();
    });
  });

  it('保存ボタンが表示される', () => {
    render(<OfflineSaveModal {...defaultProps} />);
    expect(screen.getByRole('button', { name: /バックグラウンドで保存/ })).toBeTruthy();
  });

  it('保存ボタンを押すと startDownload が呼ばれてモーダルが閉じる', async () => {
    const { startDownload } = await import('@/app/videocollect/downloadQueue');
    render(<OfflineSaveModal {...defaultProps} />);

    await waitFor(() => screen.getByRole('button', { name: /バックグラウンドで保存/ }));
    fireEvent.click(screen.getByRole('button', { name: /バックグラウンドで保存/ }));

    await waitFor(() => {
      expect(startDownload).toHaveBeenCalledWith(expect.objectContaining({
        fileId: 'file1',
        fileName: 'test.mp4',
        proxyUrl: 'https://proxy.example.com',
        accessToken: 'token',
        fileSizeBytes: 10000000,
      }));
      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });

  it('容量超過時は警告トーストを表示して startDownload を呼ばない', async () => {
    const { checkQuota } = await import('@/app/videocollect/offlineStorage');
    const { startDownload } = await import('@/app/videocollect/downloadQueue');
    vi.mocked(checkQuota).mockResolvedValue('over-limit');

    render(<OfflineSaveModal {...defaultProps} />);

    await waitFor(() => screen.getByRole('button', { name: /バックグラウンドで保存/ }));
    fireEvent.click(screen.getByRole('button', { name: /バックグラウンドで保存/ }));

    await waitFor(() => {
      expect(defaultProps.addToast).toHaveBeenCalledWith(expect.stringContaining('超えます'), 'warning');
      expect(startDownload).not.toHaveBeenCalled();
    });
  });
});
