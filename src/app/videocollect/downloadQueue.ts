import { acquireWakeLock, releaseWakeLock, isWakeLockActive } from './wakeLock';
import { saveOfflineVideo } from './offlineStorage';
import { VC_ERROR_CODES } from './constants';

export type DownloadPhase =
  | 'fetching'
  | 'saving'
  | 'done'
  | 'error';

export type DownloadTask = {
  fileId: string;
  fileName: string;
  phase: DownloadPhase;
  progress: number;
  errorCode?: string;
};

// Minimal inline types for Background Fetch API (not in standard TS lib)
interface BgFetchRegistration {
  id: string;
  downloaded: number;
  downloadTotal: number;
  result: '' | 'success' | 'failure';
  addEventListener(event: 'progress', fn: () => void): void;
  abort?(): Promise<boolean>;
  updateUI?(opts: { title?: string }): Promise<void>;
}
interface BgFetchManager {
  fetch(id: string, requests: RequestInfo[], options?: {
    title?: string;
    downloadTotal?: number;
    icons?: Array<{ src: string; sizes?: string; type?: string }>;
  }): Promise<BgFetchRegistration>;
  get(id: string): Promise<BgFetchRegistration | undefined>;
}

const tasks            = new Map<string, DownloadTask>();
const abortControllers = new Map<string, AbortController>();
const bgFetchRegs      = new Map<string, BgFetchRegistration>();
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

// SW message listener — handles BG fetch completion
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; fileId?: string; fileName?: string } | null;
    if (!data?.type || !data?.fileId) return;
    const { fileId } = data;

    if (data.type === 'vc-bgfetch-done') {
      bgFetchRegs.delete(fileId);
      if (tasks.has(fileId)) {
        abortControllers.delete(fileId);
        patch(fileId, { phase: 'done', progress: 1 });
        setTimeout(() => { tasks.delete(fileId); notify(); }, 4000);
      }
    } else if (data.type === 'vc-bgfetch-fail') {
      bgFetchRegs.delete(fileId);
      if (tasks.has(fileId)) {
        abortControllers.delete(fileId);
        patch(fileId, { phase: 'error', progress: 0, errorCode: VC_ERROR_CODES.OFFLINE_SAVE });
      }
    }
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function startDownload(opts: {
  fileId: string;
  fileName: string;
  proxyUrl: string;
  accessToken: string;
  fileSizeBytes?: number;
}): void {
  if (tasks.has(opts.fileId)) return;
  tasks.set(opts.fileId, { fileId: opts.fileId, fileName: opts.fileName, phase: 'fetching', progress: 0 });
  notify();

  acquireWakeLock().catch(() => {});
  launchWithBgFetch(opts);
}

export function cancelDownload(fileId: string): void {
  const bgReg = bgFetchRegs.get(fileId);
  if (bgReg) {
    bgReg.abort?.();
    bgFetchRegs.delete(fileId);
  }
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
  bgFetchRegs.delete(fileId);
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

// ─── BG Fetch → in-page fallback ─────────────────────────────────────────────

function launchWithBgFetch(opts: {
  fileId: string;
  fileName: string;
  proxyUrl: string;
  accessToken: string;
  fileSizeBytes?: number;
}): void {
  (async () => {
    if ('serviceWorker' in navigator) {
      const started = await tryStartBgFetch(opts).catch(() => false);
      if (started) return;
    }
    const controller = new AbortController();
    abortControllers.set(opts.fileId, controller);
    await runInPage({ ...opts, signal: controller.signal });
  })().catch(e => {
    console.error('[downloadQueue] launch error', e);
    if (tasks.has(opts.fileId)) setError(opts.fileId, VC_ERROR_CODES.OFFLINE_SAVE);
  });
}

// ─── Background Fetch ────────────────────────────────────────────────────────

async function tryStartBgFetch(opts: {
  fileId: string;
  fileName: string;
  proxyUrl: string;
  accessToken: string;
  fileSizeBytes?: number;
}): Promise<boolean> {
  const { fileId, fileName, proxyUrl, accessToken, fileSizeBytes = 0 } = opts;
  const sw = await navigator.serviceWorker.ready;
  if (!('backgroundFetch' in sw)) return false;

  const bgFetchApi = (sw as unknown as { backgroundFetch: BgFetchManager }).backgroundFetch;
  const bgFetchId  = `vc-bg-${fileId}`;
  const streamUrl  = `${proxyUrl}/stream/${encodeURIComponent(fileId)}?token=${encodeURIComponent(accessToken)}`;

  const cache = await caches.open('vc-bgfetch-meta');
  await cache.put(
    `/${bgFetchId}`,
    new Response(JSON.stringify({ fileId, fileName, quality: 'original' }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );

  const bgFetch = await bgFetchApi.fetch(
    bgFetchId,
    [new Request(streamUrl, { headers: { Range: 'bytes=0-' } })],
    { title: fileName, ...(fileSizeBytes > 0 ? { downloadTotal: fileSizeBytes } : {}) },
  );

  bgFetchRegs.set(fileId, bgFetch);

  bgFetch.addEventListener('progress', () => {
    if (bgFetch.result === 'success') {
      bgFetchRegs.delete(fileId);
      patch(fileId, { phase: 'done', progress: 1 });
      setTimeout(() => { tasks.delete(fileId); notify(); }, 4000);
    } else if (bgFetch.result === 'failure') {
      bgFetchRegs.delete(fileId);
      if (tasks.has(fileId)) setError(fileId, VC_ERROR_CODES.OFFLINE_SAVE);
    } else if (bgFetch.downloadTotal > 0) {
      patch(fileId, { phase: 'fetching', progress: bgFetch.downloaded / bgFetch.downloadTotal });
    }
  });

  return true;
}

// ─── In-page fallback: parallel chunk download ───────────────────────────────

const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB per chunk
const MAX_PARALLEL = 6;

async function runInPage(opts: {
  fileId: string;
  fileName: string;
  proxyUrl: string;
  accessToken: string;
  fileSizeBytes?: number;
  signal: AbortSignal;
}): Promise<void> {
  const { fileId, fileName, proxyUrl, accessToken, fileSizeBytes, signal } = opts;
  const streamUrl = `${proxyUrl}/stream/${encodeURIComponent(fileId)}?token=${encodeURIComponent(accessToken)}`;

  try {
    // ファイルサイズを確認（既知なら HEAD を省略）
    let total = fileSizeBytes ?? 0;
    let contentType = 'video/mp4';
    if (total === 0) {
      const head = await fetch(streamUrl, { method: 'HEAD', signal });
      total = parseInt(head.headers.get('Content-Length') ?? '0', 10);
      if (head.headers.get('Content-Type')) contentType = head.headers.get('Content-Type')!;
    }

    // サイズ不明またはサーバーが Range 非対応 → シングルストリームにフォールバック
    if (total === 0) {
      await runInPageStream({ fileId, fileName, streamUrl, contentType, signal });
      return;
    }

    // チャンク境界を計算
    const ranges: Array<[number, number]> = [];
    for (let start = 0; start < total; start += CHUNK_SIZE) {
      ranges.push([start, Math.min(start + CHUNK_SIZE - 1, total - 1)]);
    }

    const chunkCount = ranges.length;
    const results = new Array<Uint8Array[]>(chunkCount);
    const received = new Array<number>(chunkCount).fill(0);

    // セマフォで同時接続数を MAX_PARALLEL に制限
    let active = 0;
    let nextIdx = 0;
    let totalReceived = 0;

    await new Promise<void>((resolve, reject) => {
      const tryNext = () => {
        while (active < MAX_PARALLEL && nextIdx < chunkCount) {
          const idx = nextIdx++;
          active++;
          fetchChunk(streamUrl, ranges[idx], signal)
            .then(({ chunks, bytes, type }) => {
              if (type && !contentType.startsWith('video')) contentType = type;
              results[idx] = chunks;
              totalReceived += bytes - received[idx];
              received[idx] = bytes;
              patch(fileId, { phase: 'fetching', progress: totalReceived / total });
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

    patch(fileId, { phase: 'saving', progress: 1 });
    const blob = new Blob(results.flat(), { type: contentType });
    await saveOfflineVideo(fileId, fileName, blob);

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
): Promise<{ chunks: Uint8Array[]; bytes: number; type: string | null }> {
  const resp = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    signal,
  });
  if (!resp.ok && resp.status !== 206) throw new Error(`chunk fetch: ${resp.status}`);

  const reader = resp.body?.getReader();
  if (!reader) throw new Error('no body');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    bytes += value.length;
  }
  return { chunks, bytes, type: resp.headers.get('Content-Type') };
}

// ファイルサイズ不明時のフォールバック（シングルストリーム）
async function runInPageStream(opts: {
  fileId: string;
  fileName: string;
  streamUrl: string;
  contentType: string;
  signal: AbortSignal;
}): Promise<void> {
  const { fileId, fileName, streamUrl, contentType, signal } = opts;
  const resp = await fetch(streamUrl, { headers: { Range: 'bytes=0-' }, signal });
  if (!resp.ok && resp.status !== 206) throw new Error(`fetch: ${resp.status}`);

  const reader = resp.body?.getReader();
  if (!reader) throw new Error('no body');
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  if (signal.aborted) { cleanup(fileId); return; }

  patch(fileId, { phase: 'saving', progress: 1 });
  await saveOfflineVideo(fileId, fileName, new Blob(chunks, { type: resp.headers.get('Content-Type') ?? contentType }));

  abortControllers.delete(fileId);
  patch(fileId, { phase: 'done', progress: 1 });
  setTimeout(() => { tasks.delete(fileId); notify(); }, 4000);
}
