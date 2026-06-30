import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClientId } from '@/lib/utils';

describe('createClientId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses crypto.randomUUID when available', () => {
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn(() => 'uuid-from-crypto'),
    });

    expect(createClientId()).toBe('uuid-from-crypto');
  });

  it('falls back to crypto.getRandomValues when randomUUID is unavailable', () => {
    const bytes = new Uint8Array(16).fill(1);
    vi.stubGlobal('crypto', {
      getRandomValues: vi.fn((target: Uint8Array) => {
        target.set(bytes);
        return target;
      }),
    });

    const id = createClientId();

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(id[14]).toBe('4');
  });

  it('falls back to a sanitized timestamp when crypto is unavailable', () => {
    vi.stubGlobal('crypto', undefined);

    const id = createClientId();

    expect(id).toMatch(/^[a-zA-Z0-9]+$/);
  });
});
