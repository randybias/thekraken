import { describe, it, expect, vi } from 'vitest';
import {
  createChromaDriver,
  type ChromaDriver,
} from '../../e2e-chroma/chroma-driver.js';

describe('ChromaDriver', () => {
  function makeStub() {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      content: vi.fn().mockResolvedValue('<html><body>hello</body></html>'),
      innerText: vi.fn().mockResolvedValue('hello world'),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockResolvedValue(Buffer.from([])),
      close: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('http://chroma.test/'),
    };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    return { page, context };
  }

  it('exposes the documented surface', () => {
    const stub = makeStub();
    const driver: ChromaDriver = createChromaDriver({
      baseUrl: 'http://chroma.test',
      contextFactory: () =>
        Promise.resolve({ context: stub.context, page: stub.page } as never),
    });
    expect(typeof driver.goto).toBe('function');
    expect(typeof driver.pageText).toBe('function');
    expect(typeof driver.waitForText).toBe('function');
    expect(typeof driver.assertNoText).toBe('function');
    expect(typeof driver.screenshot).toBe('function');
    expect(typeof driver.close).toBe('function');
  });

  it('goto prefixes baseUrl', async () => {
    const stub = makeStub();
    const driver = createChromaDriver({
      baseUrl: 'http://chroma.test',
      contextFactory: () =>
        Promise.resolve({ context: stub.context, page: stub.page } as never),
    });
    await driver.goto('/enclaves/foo');
    expect(stub.page.goto).toHaveBeenCalledWith(
      'http://chroma.test/enclaves/foo',
      expect.any(Object),
    );
  });

  it('goto strips trailing slash from baseUrl', async () => {
    const stub = makeStub();
    const driver = createChromaDriver({
      baseUrl: 'http://chroma.test/',
      contextFactory: () =>
        Promise.resolve({ context: stub.context, page: stub.page } as never),
    });
    await driver.goto('/x');
    expect(stub.page.goto).toHaveBeenCalledWith(
      'http://chroma.test/x',
      expect.any(Object),
    );
  });

  it('pageText returns innerText', async () => {
    const stub = makeStub();
    stub.page.innerText.mockResolvedValueOnce('Hello, World');
    const driver = createChromaDriver({
      baseUrl: 'http://chroma.test',
      contextFactory: () =>
        Promise.resolve({ context: stub.context, page: stub.page } as never),
    });
    const text = await driver.pageText();
    expect(text).toBe('Hello, World');
  });

  it('assertNoText throws on forbidden string', async () => {
    const stub = makeStub();
    stub.page.innerText.mockResolvedValueOnce('contains FORBIDDEN_TOKEN');
    const driver = createChromaDriver({
      baseUrl: 'http://chroma.test',
      contextFactory: () =>
        Promise.resolve({ context: stub.context, page: stub.page } as never),
    });
    await expect(driver.assertNoText(['FORBIDDEN_TOKEN'])).rejects.toThrow(
      /forbidden/i,
    );
  });

  it('assertNoText throws on forbidden regex', async () => {
    const stub = makeStub();
    stub.page.innerText.mockResolvedValueOnce('Error: 500 Internal');
    const driver = createChromaDriver({
      baseUrl: 'http://chroma.test',
      contextFactory: () =>
        Promise.resolve({ context: stub.context, page: stub.page } as never),
    });
    await expect(driver.assertNoText([/error/i])).rejects.toThrow(/forbidden/i);
  });

  it('assertNoText passes when no forbidden patterns match', async () => {
    const stub = makeStub();
    stub.page.innerText.mockResolvedValueOnce('clean page');
    const driver = createChromaDriver({
      baseUrl: 'http://chroma.test',
      contextFactory: () =>
        Promise.resolve({ context: stub.context, page: stub.page } as never),
    });
    await expect(
      driver.assertNoText(['error', /500/]),
    ).resolves.toBeUndefined();
  });

  it('close cleans up context', async () => {
    const stub = makeStub();
    const driver = createChromaDriver({
      baseUrl: 'http://chroma.test',
      contextFactory: () =>
        Promise.resolve({ context: stub.context, page: stub.page } as never),
    });
    await driver.goto('/');
    await driver.close();
    expect(stub.context.close).toHaveBeenCalled();
  });
});
