/**
 * Unit tests for the Slack Block Kit formatter (D1).
 */
import { describe, it, expect } from 'vitest';
import {
  formatAgentResponse,
  stripMarkdownFormatting,
  translateToMrkdwn,
} from '../../src/slack/formatter.js';

describe('stripMarkdownFormatting', () => {
  it('strips **bold**', () => {
    expect(stripMarkdownFormatting('**hello**')).toBe('hello');
  });

  it('strips __bold__', () => {
    expect(stripMarkdownFormatting('__hello__')).toBe('hello');
  });

  it('strips ~~strikethrough~~', () => {
    expect(stripMarkdownFormatting('~~text~~')).toBe('text');
  });

  it('strips inline code', () => {
    expect(stripMarkdownFormatting('`code`')).toBe('code');
  });

  it('strips [link](url)', () => {
    expect(stripMarkdownFormatting('[click me](https://example.com)')).toBe(
      'click me',
    );
  });

  it('does not strip apostrophes in contractions', () => {
    const result = stripMarkdownFormatting("don't");
    expect(result).toBe("don't");
  });
});

describe('translateToMrkdwn', () => {
  it('converts **bold** to *bold*', () => {
    expect(translateToMrkdwn('**hello**')).toBe('*hello*');
  });

  it('converts __bold__ to *bold*', () => {
    expect(translateToMrkdwn('__hello__')).toBe('*hello*');
  });

  it('converts ~~strike~~ to ~strike~', () => {
    expect(translateToMrkdwn('~~text~~')).toBe('~text~');
  });

  it('converts [text](url) to <url|text>', () => {
    expect(translateToMrkdwn('[click](https://example.com)')).toBe(
      '<https://example.com|click>',
    );
  });
});

describe('formatAgentResponse', () => {
  it('returns a section block for plain text', () => {
    const result = formatAgentResponse('Hello world');
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.text).toContain('Hello world');
  });

  it('returns empty message for empty input', () => {
    const result = formatAgentResponse('');
    expect(result.blocks.length).toBe(1);
    expect(result.text).toBe('');
  });

  it('converts # header to header block', () => {
    const result = formatAgentResponse('# My Title');
    const headerBlock = result.blocks.find((b) => b.type === 'header');
    expect(headerBlock).toBeDefined();
    const hb = headerBlock as { type: 'header'; text: { text: string } };
    expect(hb.text.text).toBe('My Title');
  });

  it('converts ## header to bold section block', () => {
    const result = formatAgentResponse('## Subtitle');
    const sectionBlock = result.blocks.find((b) => b.type === 'section');
    expect(sectionBlock).toBeDefined();
    const sb = sectionBlock as {
      type: 'section';
      text: { type: string; text: string };
    };
    expect(sb.text.text).toContain('*Subtitle*');
  });

  it('converts --- to divider block', () => {
    const result = formatAgentResponse('Text\n\n---\n\nMore text');
    const divider = result.blocks.find((b) => b.type === 'divider');
    expect(divider).toBeDefined();
  });

  it('converts code block to rich_text block', () => {
    const result = formatAgentResponse('```\nconst x = 1;\n```');
    const rtBlock = result.blocks.find((b) => b.type === 'rich_text');
    expect(rtBlock).toBeDefined();
  });

  it('converts list items to bullet points', () => {
    const result = formatAgentResponse('- item one\n- item two');
    const section = result.blocks.find(
      (b) =>
        b.type === 'section' &&
        (b as { type: 'section'; text: { text: string } }).text.text.includes(
          '•',
        ),
    );
    expect(section).toBeDefined();
  });

  it('converts 2-column table to section with fields', () => {
    const md = `| Name | Value |\n|------|-------|\n| foo | bar |`;
    const result = formatAgentResponse(md);
    const sectionWithFields = result.blocks.find(
      (b) =>
        b.type === 'section' && 'fields' in b && Array.isArray(b['fields']),
    );
    expect(sectionWithFields).toBeDefined();
  });

  it('splits long responses into overflow batches of 50 blocks', () => {
    // Generate 55 headers (each becomes 1 block)
    const headers = Array.from({ length: 55 }, (_, i) => `# Header ${i}`).join(
      '\n\n',
    );
    const result = formatAgentResponse(headers);
    expect(result.blocks.length).toBe(50);
    expect(result.overflow).toBeDefined();
    expect(result.overflow!.length).toBe(1);
    expect(result.overflow![0].length).toBe(5);
  });

  it('generates plain text fallback', () => {
    const result = formatAgentResponse('**bold** and [link](https://x.com)');
    expect(result.text).toBe('bold and link');
  });

  it('handles truncated (unclosed) code block gracefully', () => {
    const result = formatAgentResponse('```\nconst x = 1;');
    const rtBlock = result.blocks.find((b) => b.type === 'rich_text');
    expect(rtBlock).toBeDefined();
  });

  it('handles wide table (3+ columns)', () => {
    const md = `| Name | Status | Version |\n|------|--------|--------|\n| my-wf | running | v1.2.3 |`;
    const result = formatAgentResponse(md);
    // Wide table: each row is a section block
    const sectionBlock = result.blocks.find((b) => b.type === 'section');
    expect(sectionBlock).toBeDefined();
  });

  it('does not treat pipe-only text without separator as table', () => {
    const md = `| just some text |`;
    const result = formatAgentResponse(md);
    // Should produce a paragraph/section, not a table with fields
    expect(result.blocks.length).toBeGreaterThan(0);
    const withFields = result.blocks.find(
      (b) => b.type === 'section' && 'fields' in b,
    );
    expect(withFields).toBeUndefined();
  });
});
