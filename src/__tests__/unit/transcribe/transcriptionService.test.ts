import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// mockGenerateContent は vi.hoisted で先に定義（vi.mock ファクトリーから参照するため）
const { mockGenerateContent } = vi.hoisted(() => ({ mockGenerateContent: vi.fn() }));

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn(function() {
    this.getGenerativeModel = vi.fn().mockReturnValue({ generateContent: mockGenerateContent });
  }),
}));

// fetch をモック（waitForFileActive 用）
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { generateTranscription } from '@/app/transcribe/transcriptionService';

const VALID_FILE_REF = JSON.stringify({
  uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123',
  name: 'files/abc123',
  mimeType: 'video/mp4',
});

describe('transcriptionService.generateTranscription', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockFetch.mockReset();
    vi.stubEnv('VITE_GOOGLE_GEMINI_API_KEY', 'test-api-key');
    // waitForFileActive: ACTIVE を即返す
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ file: { state: 'ACTIVE' } }),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('コードブロック形式の JSON をパースして返す', async () => {
    const payload = { text: 'world', paragraphs: [], keywords: [], summary: '', confidence: 0.8, language: 'en' };
    mockGenerateContent.mockResolvedValue({
      response: { text: () => `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`` },
    });

    const res = await generateTranscription(VALID_FILE_REF, 'en');
    expect(res.text).toBe('world');
    expect(res.confidence).toBe(0.8);
  });

  it('生 JSON レスポンスをパースして返す', async () => {
    const payload = { text: 'hello', paragraphs: [], keywords: ['a'], summary: 's', confidence: 0.9, language: 'ja' };
    mockGenerateContent.mockResolvedValue({
      response: { text: () => JSON.stringify(payload) },
    });

    const res = await generateTranscription(VALID_FILE_REF, 'ja');
    expect(res).toMatchObject({ text: 'hello', confidence: 0.9 });
  });

  it('JSON パース失敗時はテキストをそのまま返す', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => 'just plain text without json' },
    });

    const res = await generateTranscription(VALID_FILE_REF, 'en');
    expect(res.text).toBe('just plain text without json');
    expect(res.paragraphs).toEqual([]);
  });

  it('API キーが未設定の場合は E101 エラーを throw する', async () => {
    vi.stubEnv('VITE_GOOGLE_GEMINI_API_KEY', '');

    await expect(generateTranscription(VALID_FILE_REF)).rejects.toThrow('E101');
  });
});
