import { acquireWakeLock, releaseWakeLock, isWakeLockActive } from './wakeLock';
import { saveOfflineVideo } from './offlineStorage';
import { VC_ERROR_CODES } from './constants';

export type DownloadPhase =
  | 'fetching'
  | 'saving'
  | 'done'
  | 'error';

export type ChunkState = 'pending' | 'downloading' | 'done';

export type ChunkInfo = {
  index: number;
  total: number;
  received: number;
  status: ChunkState;
};

export type DownloadTask = {
  fileId: string;
  fileName: string;
  phase: DownloadPhase;
  progress: number;
  speed?: number;
  chunks?: ChunkInfo[];
  errorCode?: string;
  thumbnailLink?: string;
};

const tasks            = new Map<string, DownloadTask>();
const abortControllers = new Map<string, AbortController>();
const listeners        = new Set<() => void>();

function notify(): void {
  listeners.forEach(fn => fn());
}

export function subscribeTasks(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getTasks(): ReadonlyMap<string, DownloadTask> {
  return tasks;
}

export function isDownloading(fileId: string): boolean {
  const t = tasks.get(fileId);
  return !!t && t.phase !== 'done' && t.phase !== 'error';
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function startDownload(opts: {
  fileId: string;
  fileName: string;
  proxyUrl: string;
  accessToken: string;
  fileSizeBytes?: number;
  thumbnailLink?: string;
}): void {
  if (tasks.has(opts.fileId)) return;
  tasks.set(opts.fileId, { fileId: opts.fileId, fileName: opts.fileName, phase: 'fetching', progress: 0, thumbnailLink: opts.thumbnailLink });
  notify();

  acquireWakeLock().catch(() => {});
  launchDownload(opts);
}

export function cancelDownload(fileId: string): void {
  abortControllers.get(fileId)?.abort();
  abortControllers.delete(fileId);
  tasks.delete(fileId);
  notify();
}

export function dismissError(fileId: string): void {
  const t = tasks.get(fileId);
  if (t?.phase === 'error') {
    tasks.delete(fileId);
    notify();
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function patch(fileId: string, changes: Partial<DownloadTask>): void {
  const t = tasks.get(fileId);
  if (!t) return;
  tasks.set(fileId, { ...t, ...changes });
  notify();
}

function cleanup(fileId: string): void {
  abortControllers.delete(fileId);
  tasks.delete(fileId);
  notify();
  const hasActive = Array.from(tasks.values()).some(t => t.phase === 'fetching' || t.phase === 'saving');
  if (!hasActive && isWakeLockActive()) {
    releaseWakeLock().catch(() => {});
  }
}

function setError(fileId: string, errorCode: string): void {
  abortControllers.delete(fileId);
  patch(fileId, { phase: 'error', progress: 0, errorCode });
}

function launchDownload(opts: {
  fileId: string;
  fileName: string;
  proxyUrl: string;
  accessToken: string;
  fileSizeBytes?: number;
  thumbnailLink?: string;
}): void {
  (async () => {
    const controller = new AbortController();
    abortControllers.set(opts.fileId, controller);
    await runInPage({ ...opts, signal: controller.signal });
  })().catch(e => {
    console.error('[downloadQueue] launch error', e);
    if (tasks.has(opts.fileId)) setError(opts.fileId, VC_ERROR_CODES.OFFLINE_SAVE);
  });
}

// ─── In-page parallel chunk download ─────────────────────────────────────────

const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB per chunk
const MAX_PARALLEL = 6;

async function runInPage(opts: {
  fileId: string;
  fileName: string;
  proxyUrl: string;
  accessToken: string;
  fileSizeBytes?: number;
  signal: AbortSignal;
  thumbnailLink?: string;
}): Promise<void> {
  const { fileId, fileName, proxyUrl, accessToken, fileSizeBytes, signal } = opts;
  const streamUrl = `${proxyUrl}/stream/${encodeURIComponent(fileId)}?token=${encodeURIComponent(accessToken)}`;

  console.info('[downloadQueue] runInPage start', { fileId, fileSizeBytes: fileSizeBytes ?? 0 });
  try {
    // ファイルサイズを確認（既知なら HEAD を省略）
    let total = fileSizeBytes ?? 0;
    let contentType = 'video/mp4';
    if (total === 0) {
      console.info('[downloadQueue] runInPage: fileSizeBytes unknown, sending HEAD', { fileId });
      const head = await fetch(streamUrl, { method: 'HEAD', signal });
      total = parseInt(head.headers.get('Content-Length') ?? '0', 10);
      if (head.headers.get('Content-Type')) contentType = head.headers.get('Content-Type')!;
      console.info('[downloadQueue] runInPage: HEAD result', {
        fileId, status: head.status, total, contentType,
        acceptRanges: head.headers.get('Accept-Ranges'),
      });
    }

    // サイズ不明またはサーバーが Range 非対応 → シングルストリームにフォールバック
    if (total === 0) {
      console.warn('[downloadQueue] runInPage: Content-Length unknown — falling back to single stream', { fileId });
      await runInPageStream({ fileId, fileName, streamUrl, contentType, signal, thumbnailLink: opts.thumbnailLink });
      return;
    }

    console.info('[downloadQueue] runInPage: starting parallel chunks', {
      fileId, total, chunkSize: CHUNK_SIZE, maxParallel: MAX_PARALLEL,
      chunkCount: Math.ceil(total / CHUNK_SIZE),
    });

    // チャンク境界を計算
    const ranges: Array<[number, number]> = [];
    for (let start = 0; start < total; start += CHUNK_SIZE) {
      ranges.push([start, Math.min(start + CHUNK_SIZE - 1, total - 1)]);
    }

    const chunkCount = ranges.length;
    const results = new Array<Uint8Array[]>(chunkCount);

    const chunkStates: ChunkInfo[] = ranges.map((range, i) => ({
      index: i,
      total: range[1] - range[0] + 1,
      received: 0,
      status: 'pending' as ChunkState,
    }));
    patch(fileId, { chunks: [...chunkStates] });

    // セマフォで同時接続数を MAX_PARALLEL に制限
    let active = 0;
    let nextIdx = 0;
    let totalReceived = 0;
    const startTime = Date.now();

    await new Promise<void>((resolve, reject) => {
      const tryNext = () => {
        while (active < MAX_PARALLEL && nextIdx < chunkCount) {
          const idx = nextIdx++;
          active++;
          chunkStates[idx].status = 'downloading';
          patch(fileId, { chunks: [...chunkStates] });
          fetchChunk(streamUrl, ranges[idx], signal, (bytes) => {
            totalReceived += bytes;
            chunkStates[idx].received += bytes;
            const elapsedSec = (Date.now() - startTime) / 1000;
            const speed = elapsedSec > 0.2 ? (totalReceived / elapsedSec) / (1024 * 1024) : undefined;
            patch(fileId, {
              phase: 'fetching',
              progress: Math.min(totalReceived / total, 0.99),
              speed,
              chunks: [...chunkStates],
            });
          })
            .then(({ chunks, type }) => {
              if (type && !contentType.startsWith('video')) contentType = type;
              results[idx] = chunks;
              chunkStates[idx].status = 'done';
              chunkStates[idx].received = chunkStates[idx].total;
              active--;
              if (nextIdx < chunkCount) {
                tryNext();
              } else if (active === 0) {
                resolve();
              }
            })
            .catch(e => {
              if (signal.aborted) { cleanup(fileId); resolve(); } else reject(e);
            });
        }
      };
      tryNext();
    });

    if (signal.aborted) return;

    console.info('[downloadQueue] runInPage: all chunks done, saving blob', { fileId });
    patch(fileId, { phase: 'saving', progress: 1 });
    const blob = new Blob(results.flat(), { type: contentType });
    await saveOfflineVideo(fileId, fileName, blob, opts.thumbnailLink);

    console.info('[downloadQueue] runInPage: saved', { fileId, blobSize: blob.size });
    abortControllers.delete(fileId);
    patch(fileId, { phase: 'done', progress: 1 });
    setTimeout(() => { tasks.delete(fileId); notify(); }, 4000);
  } catch (e) {
    if (signal.aborted) { cleanup(fileId); return; }
    console.error('[downloadQueue] in-page error', e);
    setError(fileId, VC_ERROR_CODES.OFFLINE_SAVE);
  }
}

async function fetchChunk(
  url: string,
  [start, end]: [number, number],
  signal: AbortSignal,
  onProgress?: (bytes: number) => void,
): Promise<{ chunks: Uint8Array[]; type: string | null }> {
  const resp = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    signal,
  });
  if (!resp.ok && resp.status !== 206) throw new Error(`chunk fetch: ${resp.status}`);

  const reader = resp.body?.getReader();
  if (!reader) throw new Error('no body');
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    onProgress?.(value.length);
  }
  return { chunks, type: resp.headers.get('Content-Type') };
}

// ファイルサイズ不明時のフォールバック（シングルストリーム）
async function runInPageStream(opts: {
  fileId: string;
  fileName: string;
  streamUrl: string;
  contentType: string;
  signal: AbortSignal;
  thumbnailLink?: string;
}): Promise<void> {
  const { fileId, fileName, streamUrl, contentType, signal, thumbnailLink } = opts;
  const resp = await fetch(streamUrl, { headers: { Range: 'bytes=0-' }, signal });
  if (!resp.ok && resp.status !== 206) throw new Error(`fetch: ${resp.status}`);

  const total = parseInt(resp.headers.get('Content-Length') ?? '0', 10);
  let received = 0;
  const streamStartTime = Date.now();
  const reader = resp.body?.getReader();
  if (!reader) throw new Error('no body');
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    if (total > 0) {
      received += value.length;
      const elapsedSec = (Date.now() - streamStartTime) / 1000;
      const speed = elapsedSec > 0.2 ? (received / elapsedSec) / (1024 * 1024) : undefined;
      patch(fileId, { phase: 'fetching', progress: Math.min(received / total, 0.99), speed });
    }
  }

  if (signal.aborted) { cleanup(fileId); return; }

  patch(fileId, { phase: 'saving', progress: 1 });
  await saveOfflineVideo(fileId, fileName, new Blob(chunks, { type: resp.headers.get('Content-Type') ?? contentType }), thumbnailLink);

  abortControllers.delete(fileId);
  patch(fileId, { phase: 'done', progress: 1 });
  setTimeout(() => { tasks.delete(fileId); notify(); }, 4000);
}
