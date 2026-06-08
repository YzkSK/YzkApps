import { describe, expect, test } from 'vitest';
import { createFirebaseAuth } from '../../../../workers/drive-proxy/src/index';

describe('drive-proxy Firebase auth setup', () => {
  test('uses a stable KV cache key when verifying Firebase ID tokens', () => {
    const kv = {
      get: async () => null,
      put: async () => undefined,
    };

    const auth = createFirebaseAuth({
      FIREBASE_PROJECT_ID: 'test-project',
      PUBLIC_JWK_CACHE_KEY: 'firebase-public-jwk',
      PUBLIC_JWK_CACHE_KV: kv,
    });
    const authInternals = auth as unknown as {
      idTokenVerifier: {
        projectId: string;
        signatureVerifier: {
          keyFetcher: {
            keyStorer: {
              cacheKey: string;
              cfKVNamespace: typeof kv;
            };
          };
        };
      };
    };
    const keyStore = authInternals.idTokenVerifier.signatureVerifier.keyFetcher.keyStorer;

    expect(authInternals.idTokenVerifier.projectId).toBe('test-project');
    expect(keyStore.cacheKey).toBe('firebase-public-jwk');
    expect(keyStore.cfKVNamespace).toBe(kv);
  });
});
