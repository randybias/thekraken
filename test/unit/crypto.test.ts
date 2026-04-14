import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, parseEncryptionKey } from '../../src/auth/crypto.js';

// A valid 32-byte test key (all 0xab bytes)
const TEST_KEY = Buffer.alloc(32, 0xab);
const TEST_KEY_HEX = TEST_KEY.toString('hex'); // 64 hex chars
const TEST_KEY_B64 = TEST_KEY.toString('base64'); // 44 base64 chars

describe('parseEncryptionKey', () => {
  it('parses a 64-char hex key to 32 bytes', () => {
    const key = parseEncryptionKey(TEST_KEY_HEX);
    expect(key.length).toBe(32);
    expect(key.equals(TEST_KEY)).toBe(true);
  });

  it('parses a base64-encoded 32-byte key', () => {
    const key = parseEncryptionKey(TEST_KEY_B64);
    expect(key.length).toBe(32);
    expect(key.equals(TEST_KEY)).toBe(true);
  });

  it('throws on hex key with wrong length (too short)', () => {
    expect(() => parseEncryptionKey('aabbcc')).toThrow(
      /Encryption key must be exactly 32 bytes/,
    );
  });

  it('throws on base64 key that decodes to wrong length', () => {
    // 16 bytes base64
    const short = Buffer.alloc(16, 0xff).toString('base64');
    expect(() => parseEncryptionKey(short)).toThrow(
      /Encryption key must be exactly 32 bytes/,
    );
  });

  it('throws on empty string', () => {
    expect(() => parseEncryptionKey('')).toThrow(
      /Encryption key must be exactly 32 bytes/,
    );
  });

  it('accepts all-zero 64-hex-char key', () => {
    const key = parseEncryptionKey('0'.repeat(64));
    expect(key.length).toBe(32);
    expect(key.every((b) => b === 0)).toBe(true);
  });
});

describe('encrypt / decrypt roundtrip', () => {
  it('roundtrips a plain string', () => {
    const plaintext = 'hello world';
    const ciphertext = encrypt(plaintext, TEST_KEY);
    expect(decrypt(ciphertext, TEST_KEY)).toBe(plaintext);
  });

  it('roundtrips an empty string', () => {
    const ciphertext = encrypt('', TEST_KEY);
    expect(decrypt(ciphertext, TEST_KEY)).toBe('');
  });

  it('roundtrips a JWT-like string', () => {
    const jwt =
      'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEifQ.sig';
    const ciphertext = encrypt(jwt, TEST_KEY);
    expect(decrypt(ciphertext, TEST_KEY)).toBe(jwt);
  });

  it('produces different ciphertexts for same plaintext (random IV)', () => {
    const plaintext = 'same plaintext';
    const ct1 = encrypt(plaintext, TEST_KEY);
    const ct2 = encrypt(plaintext, TEST_KEY);
    // Different IVs guarantee different ciphertexts
    expect(ct1).not.toBe(ct2);
    // Both decrypt correctly
    expect(decrypt(ct1, TEST_KEY)).toBe(plaintext);
    expect(decrypt(ct2, TEST_KEY)).toBe(plaintext);
  });

  it('ciphertext format is iv:ciphertext:authTag with 3 parts', () => {
    const ciphertext = encrypt('test', TEST_KEY);
    const parts = ciphertext.split(':');
    expect(parts.length).toBe(3);
    // IV: 12 bytes = 24 hex chars
    expect(parts[0]!.length).toBe(24);
    // authTag: 16 bytes = 32 hex chars
    expect(parts[2]!.length).toBe(32);
  });
});

describe('decrypt tamper detection', () => {
  it('throws on tampered ciphertext (modified data)', () => {
    const ciphertext = encrypt('sensitive', TEST_KEY);
    const parts = ciphertext.split(':');
    // Flip a byte in the ciphertext segment
    const tampered = parts[1]!.replace(/^(..)/, (m) => {
      const byte = parseInt(m, 16);
      return ((byte ^ 0xff) & 0xff).toString(16).padStart(2, '0');
    });
    const tamperedCiphertext = `${parts[0]}:${tampered}:${parts[2]}`;
    expect(() => decrypt(tamperedCiphertext, TEST_KEY)).toThrow();
  });

  it('throws on tampered auth tag', () => {
    const ciphertext = encrypt('sensitive', TEST_KEY);
    const parts = ciphertext.split(':');
    const tamperedTag = parts[2]!.replace(/^(..)/, '00');
    const tamperedCiphertext = `${parts[0]}:${parts[1]}:${tamperedTag}`;
    expect(() => decrypt(tamperedCiphertext, TEST_KEY)).toThrow();
  });

  it('throws on wrong decryption key', () => {
    const ciphertext = encrypt('sensitive', TEST_KEY);
    const wrongKey = Buffer.alloc(32, 0x00);
    expect(() => decrypt(ciphertext, wrongKey)).toThrow();
  });

  it('throws on malformed ciphertext (missing colons)', () => {
    expect(() => decrypt('notavalidciphertext', TEST_KEY)).toThrow(
      /Malformed ciphertext/,
    );
  });

  it('throws on ciphertext with too many parts', () => {
    expect(() => decrypt('a:b:c:d', TEST_KEY)).toThrow(/Malformed ciphertext/);
  });
});
