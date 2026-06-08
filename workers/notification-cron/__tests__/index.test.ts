import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  base64url,
  encodeObj,
  pemToArrayBuffer,
  fsValue,
  parseDoc,
  timeToMin,
  todayKey,
  nowMinJst,
} from '../src/index';

// ── base64url ─────────────────────────────────────────────────
describe('base64url', () => {
  it('空の ArrayBuffer は空文字を返す', () => {
    expect(base64url(new ArrayBuffer(0))).toBe('');
  });

  it('+, /, = を URL-safe な文字に置換する', () => {
    const result = base64url(new Uint8Array([0xfb, 0xff, 0xfe]).buffer);
    expect(result).not.toMatch(/[+/=]/);
    expect(result).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('既知のバイト列を正しくエンコードする', () => {
    // [0x00] → base64 = "AA==" → base64url = "AA"
    expect(base64url(new Uint8Array([0x00]).buffer)).toBe('AA');
    // [0xff, 0xff] → base64 = "//8=" → base64url = "__8"
    expect(base64url(new Uint8Array([0xff, 0xff]).buffer)).toBe('__8');
  });
});

// ── encodeObj ─────────────────────────────────────────────────
describe('encodeObj', () => {
  it('JSON を base64url エンコードする', () => {
    const result = encodeObj({ alg: 'RS256', typ: 'JWT' });
    expect(result).not.toMatch(/[+/=]/);
    // デコードして元のオブジェクトと一致するか確認
    const decoded = JSON.parse(atob(result.replace(/-/g, '+').replace(/_/g, '/')));
    expect(decoded).toEqual({ alg: 'RS256', typ: 'JWT' });
  });

  it('空オブジェクトもエンコードできる', () => {
    const result = encodeObj({});
    const decoded = JSON.parse(atob(result.replace(/-/g, '+').replace(/_/g, '/')));
    expect(decoded).toEqual({});
  });
});

// ── pemToArrayBuffer ──────────────────────────────────────────
describe('pemToArrayBuffer', () => {
  it('PEM ヘッダー・フッター・空白を取り除いて ArrayBuffer を返す', () => {
    // "hello" = base64 では "aGVsbG8="
    const pem = `-----BEGIN PRIVATE KEY-----\naGVsbG8=\n-----END PRIVATE KEY-----`;
    const buf = pemToArrayBuffer(pem);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    const decoded = new TextDecoder().decode(buf);
    expect(decoded).toBe('hello');
  });
});

// ── fsValue ───────────────────────────────────────────────────
describe('fsValue', () => {
  it('stringValue を文字列として返す', () => {
    expect(fsValue({ stringValue: '東京' })).toBe('東京');
  });

  it('integerValue を数値として返す', () => {
    expect(fsValue({ integerValue: '42' })).toBe(42);
    expect(fsValue({ integerValue: '-10' })).toBe(-10);
  });

  it('doubleValue を数値として返す', () => {
    expect(fsValue({ doubleValue: 3.14 })).toBe(3.14);
  });

  it('booleanValue を真偽値として返す', () => {
    expect(fsValue({ booleanValue: true })).toBe(true);
    expect(fsValue({ booleanValue: false })).toBe(false);
  });

  it('mapValue をオブジェクトに変換する', () => {
    const v = {
      mapValue: {
        fields: {
          name: { stringValue: '太郎' },
          age: { integerValue: '20' },
        },
      },
    };
    expect(fsValue(v)).toEqual({ name: '太郎', age: 20 });
  });

  it('mapValue.fields がない場合は空オブジェクトを返す', () => {
    expect(fsValue({ mapValue: {} })).toEqual({});
  });

  it('arrayValue を配列に変換する', () => {
    const v = {
      arrayValue: {
        values: [
          { stringValue: 'a' },
          { integerValue: '1' },
        ],
      },
    };
    expect(fsValue(v)).toEqual(['a', 1]);
  });

  it('arrayValue.values がない場合は空配列を返す', () => {
    expect(fsValue({ arrayValue: {} })).toEqual([]);
  });

  it('mapValue をネストして変換する', () => {
    const v = {
      mapValue: {
        fields: {
          inner: {
            mapValue: {
              fields: { x: { integerValue: '5' } },
            },
          },
        },
      },
    };
    expect(fsValue(v)).toEqual({ inner: { x: 5 } });
  });

  it('未知のフィールドは null を返す', () => {
    expect(fsValue({})).toBeNull();
    expect(fsValue({ unknownField: 'value' })).toBeNull();
  });
});

// ── parseDoc ──────────────────────────────────────────────────
describe('parseDoc', () => {
  it('Firestore ドキュメントのフィールドを JS オブジェクトに変換する', () => {
    const doc = {
      name: 'projects/p/databases/(default)/documents/users/uid',
      fields: {
        token: { stringValue: 'fcm-token-xxx' },
        notifyBefore: { integerValue: '10' },
        enabled: { booleanValue: true },
      },
    };
    expect(parseDoc(doc)).toEqual({
      token: 'fcm-token-xxx',
      notifyBefore: 10,
      enabled: true,
    });
  });

  it('fields がない場合は空オブジェクトを返す', () => {
    expect(parseDoc({})).toEqual({});
    expect(parseDoc({ name: 'path/to/doc' })).toEqual({});
  });
});

// ── timeToMin ─────────────────────────────────────────────────
describe('timeToMin', () => {
  it('HH:MM を分に変換する', () => {
    expect(timeToMin('00:00')).toBe(0);
    expect(timeToMin('09:00')).toBe(540);
    expect(timeToMin('09:30')).toBe(570);
    expect(timeToMin('23:59')).toBe(1439);
  });
});

// ── todayKey / nowMinJst ──────────────────────────────────────
describe('todayKey', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('UTC 15:00 は JST 翌 00:00 → 翌日の dateKey を返す', () => {
    // UTC 2024-01-31 15:00:00 → JST 2024-02-01 00:00:00
    vi.setSystemTime(new Date('2024-01-31T15:00:00Z'));
    expect(todayKey()).toBe('2024-02-01');
  });

  it('UTC 00:00 は JST 09:00 → 同日の dateKey を返す', () => {
    // UTC 2024-03-10 00:00:00 → JST 2024-03-10 09:00:00
    vi.setSystemTime(new Date('2024-03-10T00:00:00Z'));
    expect(todayKey()).toBe('2024-03-10');
  });

  it('月と日を2桁でゼロパディングする', () => {
    // UTC 2024-01-04 00:00:00 → JST 2024-01-04 09:00:00
    vi.setSystemTime(new Date('2024-01-04T00:00:00Z'));
    expect(todayKey()).toBe('2024-01-04');
  });
});

describe('nowMinJst', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('UTC 00:00 は JST 09:00 → 540 分を返す', () => {
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    expect(nowMinJst()).toBe(540); // 9 * 60
  });

  it('UTC 00:30 は JST 09:30 → 570 分を返す', () => {
    vi.setSystemTime(new Date('2024-01-01T00:30:00Z'));
    expect(nowMinJst()).toBe(570); // 9 * 60 + 30
  });

  it('UTC 15:00 は JST 翌 00:00 → 0 分を返す', () => {
    vi.setSystemTime(new Date('2024-01-01T15:00:00Z'));
    expect(nowMinJst()).toBe(0);
  });

  it('UTC 23:59 は JST 翌 08:59 → 539 分を返す', () => {
    vi.setSystemTime(new Date('2024-01-01T23:59:00Z'));
    expect(nowMinJst()).toBe(539); // 8 * 60 + 59
  });
});

// ── scheduled ハンドラーの安全性 ─────────────────────────────────
describe('scheduled handler (クラッシュ安全性)', () => {
  it('GOOGLE_SERVICE_ACCOUNT が不正 JSON でも例外がスローされない', async () => {
    // scheduled をデフォルトエクスポートから取得して呼び出す
    const mod = await import('../src/index');
    const handler = (mod as unknown as { default: { scheduled: (e: unknown, env: unknown) => Promise<void> } }).default;

    const env = {
      GOOGLE_SERVICE_ACCOUNT: 'INVALID_JSON',
      FIREBASE_PROJECT_ID: 'test-project',
    };

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(handler.scheduled({} as unknown, env)).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
