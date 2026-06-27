// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

const DB_STORE: Record<string, unknown> = {};

function makeMockReq<T>(result: T) {
  const req: { result: T; onsuccess: ((e: Event) => void) | null; onerror: null } = {
    result,
    onsuccess: null,
    onerror: null,
  };
  setTimeout(() => {
    if (req.onsuccess) req.onsuccess(new Event('success'));
  }, 0);
  return req;
}

const mockStore = {
  put: (value: unknown) => {
    const entry = value as { fileId: string };
    DB_STORE[entry.fileId] = value;
    return makeMockReq(undefined);
  },
  get: (key: string) => makeMockReq(DB_STORE[key] ?? undefined),
  getKey: (key: string) => makeMockReq(key in DB_STORE ? key : undefined),
  delete: (key: string) => {
    delete DB_STORE[key];
    return makeMockReq(undefined);
  },
  getAllKeys: () => makeMockReq(Object.keys(DB_STORE)),
  getAll: () => makeMockReq(Object.values(DB_STORE)),
};

const mockDb = {
  transaction: (_: string, __: string) => ({ objectStore: () => mockStore }),
  createObjectStore: vi.fn(),
};

vi.stubGlobal('indexedDB', {
  open: () => {
    const req = {
      result: mockDb,
      onupgradeneeded: null as ((e: Event) => void) | null,
      onsuccess: null as ((e: Event) => void) | null,
      onerror: null,
    };
    setTimeout(() => { if (req.onsuccess) req.onsuccess(new Event('success')); }, 0);
    return req;
  },
});

const {
  saveOfflineVideo,
  loadOfflineVideo,
  deleteOfflineVideo,
  listOfflineSavedIds,
  isOfflineSaved,
  getOfflineStorageUsage,
  getStorageLimitGb,
  setStorageLimitGb,
  checkQuota,
  listOfflineEntries,   // 追加
} = await import('@/app/videocollect/offlineStorage');

describe('offlineStorage', () => {
  beforeEach(() => {
    Object.keys(DB_STORE).forEach(k => delete DB_STORE[k]);
    localStorage.removeItem('vc-offline-limit-gb');
  });

  describe('getStorageLimitGb / setStorageLimitGb', () => {
    it('デフォルト値は 5 を返す', () => {
      expect(getStorageLimitGb()).toBe(5);
    });

    it('設定した値を返す', () => {
      setStorageLimitGb(20);
      expect(getStorageLimitGb()).toBe(20);
    });

    it('1 未満は 1 に補正する', () => {
      setStorageLimitGb(0);
      expect(getStorageLimitGb()).toBe(1);
    });
  });

  describe('saveOfflineVideo / loadOfflineVideo', () => {
    it('保存した blob を取得できる', async () => {
      const blob = new Blob(['test'], { type: 'video/mp4' });
      await saveOfflineVideo('file1', 'test.mp4', blob);
      const loaded = await loadOfflineVideo('file1');
      expect(loaded).not.toBeNull();
    });

    it('存在しない ID は null を返す', async () => {
      const loaded = await loadOfflineVideo('nonexistent');
      expect(loaded).toBeNull();
    });

    it('thumbnailLink を保存・復元できる', async () => {
      const blob = new Blob(['test'], { type: 'video/mp4' });
      await saveOfflineVideo('file-thumb', 'thumb.mp4', blob, 'https://example.com/thumb.jpg');
      const entries = await listOfflineEntries();
      const entry = entries.find(e => e.fileId === 'file-thumb');
      expect(entry?.thumbnailLink).toBe('https://example.com/thumb.jpg');
    });

    it('thumbnailLink なしで保存した場合は undefined になる', async () => {
      const blob = new Blob(['test2'], { type: 'video/mp4' });
      await saveOfflineVideo('file-no-thumb', 'no-thumb.mp4', blob);
      const entries = await listOfflineEntries();
      const entry = entries.find(e => e.fileId === 'file-no-thumb');
      expect(entry?.thumbnailLink).toBeUndefined();
    });
  });

  describe('deleteOfflineVideo', () => {
    it('削除後に null が返る', async () => {
      const blob = new Blob(['data'], { type: 'video/mp4' });
      await saveOfflineVideo('file2', 'test.mp4', blob);
      await deleteOfflineVideo('file2');
      const loaded = await loadOfflineVideo('file2');
      expect(loaded).toBeNull();
    });
  });

  describe('listOfflineSavedIds', () => {
    it('保存済み ID の一覧を返す', async () => {
      const b1 = new Blob(['a'], { type: 'video/mp4' });
      const b2 = new Blob(['b'], { type: 'video/mp4' });
      await saveOfflineVideo('id-a', 'a.mp4', b1);
      await saveOfflineVideo('id-b', 'b.mp4', b2);
      const ids = await listOfflineSavedIds();
      expect(ids).toContain('id-a');
      expect(ids).toContain('id-b');
    });
  });

  describe('isOfflineSaved', () => {
    it('保存済みなら true を返す', async () => {
      const blob = new Blob(['x'], { type: 'video/mp4' });
      await saveOfflineVideo('file3', 'x.mp4', blob);
      expect(await isOfflineSaved('file3')).toBe(true);
    });

    it('未保存なら false を返す', async () => {
      expect(await isOfflineSaved('unknown-file')).toBe(false);
    });
  });

  describe('getOfflineStorageUsage', () => {
    it('件数とバイト数を返す', async () => {
      const blob = new Blob(['hello'], { type: 'video/mp4' });
      await saveOfflineVideo('usage-test', 'h.mp4', blob);
      const usage = await getOfflineStorageUsage();
      expect(usage.count).toBe(1);
      expect(usage.totalBytes).toBeGreaterThan(0);
    });

    it('空のストアは count=0、totalBytes=0 を返す', async () => {
      const usage = await getOfflineStorageUsage();
      expect(usage.count).toBe(0);
      expect(usage.totalBytes).toBe(0);
    });
  });

  describe('checkQuota', () => {
    it('上限以内なら ok を返す', async () => {
      setStorageLimitGb(10);
      const result = await checkQuota(1024);
      expect(result).toBe('ok');
    });

    it('上限超過なら over-limit を返す', async () => {
      setStorageLimitGb(1);
      const result = await checkQuota(1024 * 1024 * 1024 + 1);
      expect(result).toBe('over-limit');
    });
  });

  describe('listOfflineEntries', () => {
    it('blob を含まないメタデータ一覧を返す', async () => {
      const b1 = new Blob(['a'], { type: 'video/mp4' });
      const b2 = new Blob(['b'], { type: 'video/mp4' });
      await saveOfflineVideo('meta-a', 'a.mp4', b1, 'https://example.com/a.jpg');
      await saveOfflineVideo('meta-b', 'b.mp4', b2);
      const entries = await listOfflineEntries();
      const a = entries.find(e => e.fileId === 'meta-a');
      const b = entries.find(e => e.fileId === 'meta-b');
      expect(a?.fileName).toBe('a.mp4');
      expect(a?.thumbnailLink).toBe('https://example.com/a.jpg');
      expect(b?.fileName).toBe('b.mp4');
      expect(b?.thumbnailLink).toBeUndefined();
      // blob は含まれない
      expect((a as unknown as { blob?: unknown })?.blob).toBeUndefined();
    });
  });
});
