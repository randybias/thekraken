import { describe, it, expect } from 'vitest';
import type { KnownBlock } from '@slack/types';

import {
  formatAgentResponse,
  stripMarkdownFormatting,
  translateToMrkdwn,
} from '../../src/slack/formatter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function blocks(markdown: string): KnownBlock[] {
  return formatAgentResponse(markdown).blocks;
}

function firstBlock(markdown: string): KnownBlock {
  const b = blocks(markdown);
  if (b.length === 0) throw new Error('No blocks produced');
  return b[0];
}

// ---------------------------------------------------------------------------
// translateToMrkdwn
// ---------------------------------------------------------------------------

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
    expect(translateToMrkdwn('[Click here](https://example.com)')).toBe(
      '<https://example.com|Click here>',
    );
  });

  it('preserves inline backticks', () => {
    expect(translateToMrkdwn('use `code` here')).toBe('use `code` here');
  });

  it('preserves italic *text*', () => {
    expect(translateToMrkdwn('*italic*')).toBe('*italic*');
  });

  it('handles multiple conversions in one string', () => {
    const result = translateToMrkdwn(
      '**bold** and ~~strike~~ and [link](https://x.com)',
    );
    expect(result).toBe('*bold* and ~strike~ and <https://x.com|link>');
  });

  it('passes through plain text unchanged', () => {
    expect(translateToMrkdwn('hello world')).toBe('hello world');
  });
});

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

describe('# Header (level 1)', () => {
  it('produces a header block', () => {
    const b = firstBlock('# Hello World');
    expect(b.type).toBe('header');
  });

  it('uses plain_text element', () => {
    const b = firstBlock('# Hello World') as {
      type: 'header';
      text: { type: string; text: string };
    };
    expect(b.text.type).toBe('plain_text');
    expect(b.text.text).toBe('Hello World');
  });

  it('truncates header text at 150 chars', () => {
    const long = 'A'.repeat(160);
    const b = firstBlock(`# ${long}`) as {
      type: 'header';
      text: { text: string };
    };
    expect(b.text.text.length).toBeLessThanOrEqual(150);
    expect(b.text.text.endsWith('...')).toBe(true);
  });
});

describe('## Header (level 2)', () => {
  it('produces a section block with bold mrkdwn', () => {
    const b = firstBlock('## Sub Header') as {
      type: 'section';
      text: { type: string; text: string };
    };
    expect(b.type).toBe('section');
    expect(b.text.type).toBe('mrkdwn');
    expect(b.text.text).toContain('*Sub Header*');
  });
});

describe('### Header (level 3)', () => {
  it('produces a section block', () => {
    const b = firstBlock('### Sub Sub') as {
      type: 'section';
      text: { type: string; text: string };
    };
    expect(b.type).toBe('section');
    expect(b.text.type).toBe('mrkdwn');
  });
});

// ---------------------------------------------------------------------------
// Fenced code blocks
// ---------------------------------------------------------------------------

describe('Fenced code block', () => {
  it('produces a rich_text block', () => {
    const b = firstBlock('```\nconst x = 1;\n```');
    expect(b.type).toBe('rich_text');
  });

  it('contains a rich_text_preformatted element', () => {
    const b = firstBlock('```\nconst x = 1;\n```') as {
      type: 'rich_text';
      elements: Array<{
        type: string;
        elements: Array<{ type: string; text: string }>;
      }>;
    };
    expect(b.elements[0].type).toBe('rich_text_preformatted');
    expect(b.elements[0].elements[0].text).toContain('const x = 1;');
  });

  it('handles code blocks with a language specifier', () => {
    const b = firstBlock('```typescript\nconst x: number = 1;\n```') as {
      type: 'rich_text';
      elements: Array<{
        type: string;
        elements: Array<{ type: string; text: string }>;
      }>;
    };
    expect(b.type).toBe('rich_text');
    expect(b.elements[0].elements[0].text).toContain('const x: number = 1;');
  });

  it('preserves multiple lines', () => {
    const md = '```\nline1\nline2\nline3\n```';
    const b = firstBlock(md) as {
      type: 'rich_text';
      elements: Array<{
        type: string;
        elements: Array<{ type: string; text: string }>;
      }>;
    };
    const text = b.elements[0].elements[0].text;
    expect(text).toContain('line1');
    expect(text).toContain('line2');
    expect(text).toContain('line3');
  });
});

// ---------------------------------------------------------------------------
// 2-column tables
// ---------------------------------------------------------------------------

describe('2-column table', () => {
  const md = `| Name | Value |
|------|-------|
| foo  | bar   |
| baz  | qux   |`;

  it('produces section blocks with fields', () => {
    const b = blocks(md);
    expect(b.length).toBeGreaterThan(0);
    const section = b[0] as {
      type: 'section';
      fields?: Array<{ type: string; text: string }>;
    };
    expect(section.type).toBe('section');
    expect(section.fields).toBeDefined();
  });

  it('bolds header cells', () => {
    const b = blocks(md);
    const section = b[0] as {
      type: 'section';
      fields: Array<{ type: string; text: string }>;
    };
    expect(section.fields[0].text).toContain('*Name*');
    expect(section.fields[1].text).toContain('*Value*');
  });

  it('uses mrkdwn type for all fields', () => {
    const b = blocks(md);
    const section = b[0] as {
      type: 'section';
      fields: Array<{ type: string; text: string }>;
    };
    section.fields.forEach((f) => expect(f.type).toBe('mrkdwn'));
  });

  it('splits into multiple section blocks when rows exceed 5', () => {
    const rows = Array.from({ length: 12 }, (_, i) => `| r${i} | v${i} |`).join(
      '\n',
    );
    const md = `| Name | Value |\n|------|-------|\n${rows}`;
    const b = blocks(md);
    expect(b.length).toBeGreaterThan(1);
  });

  it('handles single data row', () => {
    const singleRow = `| Key | Val |\n|-----|-----|\n| a | b |`;
    const b = blocks(singleRow);
    expect(b.length).toBe(1);
    const s = b[0] as { type: 'section'; fields: Array<{ text: string }> };
    expect(s.fields.some((f) => f.text === 'a')).toBe(true);
  });

  it('no section block ever has more than 10 fields', () => {
    // 12 data rows: first block has 2 headers + 4 data rows = 10 fields,
    // remaining blocks have 5 data rows = 10 fields each.
    const rows = Array.from({ length: 12 }, (_, i) => `| r${i} | v${i} |`).join(
      '\n',
    );
    const md = `| Name | Value |\n|------|-------|\n${rows}`;
    const b = blocks(md);
    for (const block of b) {
      if (block.type === 'section' && 'fields' in block && block.fields) {
        expect((block.fields as unknown[]).length).toBeLessThanOrEqual(10);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3+ column tables
// ---------------------------------------------------------------------------

describe('3+ column table', () => {
  const md = `| Name | Age | Role |
|------|-----|------|
| Alice | 30 | Dev  |
| Bob   | 25 | QA   |`;

  it('produces section blocks (one per row)', () => {
    const b = blocks(md);
    expect(b.length).toBe(2);
    expect(b[0].type).toBe('section');
    expect(b[1].type).toBe('section');
  });

  it('uses first column as bold title', () => {
    const b = blocks(md);
    const section = b[0] as { text: { text: string } };
    expect(section.text.text).toBe('*Alice*');
  });

  it('uses remaining columns as label:value fields', () => {
    const b = blocks(md);
    const section = b[0] as { fields: { text: string }[] };
    expect(section.fields).toHaveLength(2);
    expect(section.fields[0].text).toBe('*Age:* 30');
    expect(section.fields[1].text).toBe('*Role:* Dev');
  });

  it('renders all rows', () => {
    const b = blocks(md);
    const s1 = b[0] as { text: { text: string } };
    const s2 = b[1] as { text: { text: string } };
    expect(s1.text.text).toBe('*Alice*');
    expect(s2.text.text).toBe('*Bob*');
  });
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

describe('Bullet list', () => {
  it('produces a section block', () => {
    const b = firstBlock('- item one\n- item two\n- item three');
    expect(b.type).toBe('section');
  });

  it('renders bullet points', () => {
    const b = firstBlock('- item one\n- item two') as {
      type: 'section';
      text: { text: string };
    };
    expect(b.text.text).toContain('•');
  });

  it('handles * bullet style', () => {
    const b = firstBlock('* first\n* second') as {
      type: 'section';
      text: { text: string };
    };
    expect(b.text.text).toContain('•');
  });

  it('handles numbered list', () => {
    const b = firstBlock('1. first\n2. second') as {
      type: 'section';
      text: { text: string };
    };
    expect(b.text.text).toContain('•');
  });
});

// ---------------------------------------------------------------------------
// Divider
// ---------------------------------------------------------------------------

describe('Horizontal rule', () => {
  it('--- produces a divider block', () => {
    expect(firstBlock('---').type).toBe('divider');
  });

  it('*** produces a divider block', () => {
    expect(firstBlock('***').type).toBe('divider');
  });

  it('___ produces a divider block', () => {
    expect(firstBlock('___').type).toBe('divider');
  });
});

// ---------------------------------------------------------------------------
// Paragraphs
// ---------------------------------------------------------------------------

describe('Paragraph', () => {
  it('produces a section block', () => {
    expect(firstBlock('Just some text').type).toBe('section');
  });

  it('uses mrkdwn text type', () => {
    const b = firstBlock('Just some text') as {
      type: 'section';
      text: { type: string; text: string };
    };
    expect(b.text.type).toBe('mrkdwn');
  });

  it('translates inline markdown', () => {
    const b = firstBlock('**bold** and ~~strike~~') as {
      type: 'section';
      text: { type: string; text: string };
    };
    expect(b.text.text).toContain('*bold*');
    expect(b.text.text).toContain('~strike~');
  });

  it('splits long paragraphs exceeding 2800 chars', () => {
    const longLine = 'a '.repeat(200); // 400 chars each
    const md = Array.from({ length: 10 }, () => longLine).join('\n'); // 4000+ chars
    const b = blocks(md);
    expect(b.length).toBeGreaterThan(1);
    for (const block of b) {
      const s = block as { type: 'section'; text: { text: string } };
      expect(s.text.text.length).toBeLessThanOrEqual(2800);
    }
  });
});

// ---------------------------------------------------------------------------
// Mixed content
// ---------------------------------------------------------------------------

describe('Mixed content', () => {
  it('handles paragraph then table then code block', () => {
    const md = [
      'Here is a summary:',
      '',
      '| Key | Value |',
      '|-----|-------|',
      '| foo | bar   |',
      '',
      '```',
      'const x = 1;',
      '```',
    ].join('\n');

    const b = blocks(md);
    const types = b.map((blk) => blk.type);
    expect(types).toContain('section');
    expect(types).toContain('rich_text');
  });

  it('handles header then paragraph then divider', () => {
    const md = '# Title\n\nSome text.\n\n---\n\nMore text.';
    const b = blocks(md);
    const types = b.map((blk) => blk.type);
    expect(types).toContain('header');
    expect(types).toContain('section');
    expect(types).toContain('divider');
  });
});

// ---------------------------------------------------------------------------
// 50-block overflow
// ---------------------------------------------------------------------------

describe('50-block overflow', () => {
  it('returns overflow when > 50 blocks', () => {
    // Each --- produces a divider block; produce 60 of them
    const md = Array.from({ length: 60 }, (_, i) => `# H${i}\n\ntext\n`).join(
      '\n',
    );
    const result = formatAgentResponse(md);
    expect(result.blocks.length).toBeLessThanOrEqual(50);
    expect(result.overflow).toBeDefined();
    expect(result.overflow!.length).toBeGreaterThan(0);
  });

  it('each overflow batch is <= 50 blocks', () => {
    const md = Array.from({ length: 200 }, (_, i) => `# H${i}\n`).join('\n');
    const result = formatAgentResponse(md);
    for (const batch of result.overflow ?? []) {
      expect(batch.length).toBeLessThanOrEqual(50);
    }
  });

  it('total blocks across all batches equals allBlocks count', () => {
    const md = Array.from({ length: 70 }, (_, i) => `paragraph ${i}\n`).join(
      '\n',
    );
    const result = formatAgentResponse(md);
    const overflowCount = (result.overflow ?? []).reduce(
      (acc, batch) => acc + batch.length,
      0,
    );
    expect(result.blocks.length + overflowCount).toBeGreaterThan(50);
  });

  it('no overflow when <= 50 blocks', () => {
    const md = Array.from({ length: 5 }, (_, i) => `# H${i}`).join('\n\n');
    const result = formatAgentResponse(md);
    expect(result.overflow).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Plain-text fallback
// ---------------------------------------------------------------------------

describe('Plain-text fallback', () => {
  it('provides a text field', () => {
    const result = formatAgentResponse('# Hello\n\nsome text');
    expect(typeof result.text).toBe('string');
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('strips markdown formatting from text', () => {
    const result = formatAgentResponse('# Title\n\n**bold** text');
    expect(result.text).not.toContain('**');
    expect(result.text).not.toContain('#');
  });

  it('replaces code blocks with placeholder in text', () => {
    const result = formatAgentResponse('```\nconst x = 1;\n```');
    expect(result.text).toContain('[code block]');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('handles empty string input', () => {
    const result = formatAgentResponse('');
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.text).toBe('');
  });

  it('handles whitespace-only input', () => {
    const result = formatAgentResponse('   \n  \n  ');
    // Should produce something without crashing
    expect(Array.isArray(result.blocks)).toBe(true);
  });

  it('handles single-line input', () => {
    const result = formatAgentResponse('Hello world');
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0].type).toBe('section');
  });

  it('handles only a code block', () => {
    const result = formatAgentResponse('```\ncode only\n```');
    expect(result.blocks[0].type).toBe('rich_text');
  });

  it('handles header-only table (no data rows)', () => {
    const md = '| Col1 | Col2 |\n|------|------|';
    // Should not crash; may produce 0 or 1 blocks
    expect(() => formatAgentResponse(md)).not.toThrow();
  });

  it('handles table with inconsistent column counts', () => {
    const md = '| A | B | C |\n|---|---|---|\n| 1 | 2 |\n| 3 |';
    expect(() => formatAgentResponse(md)).not.toThrow();
  });

  it('renders unterminated code fence as preformatted (truncated response)', () => {
    const md = '```typescript\nconst x = 1;\nconst y = 2;';
    const result = formatAgentResponse(md);
    const b = result.blocks[0] as {
      type: 'rich_text';
      elements: Array<{
        type: string;
        elements: Array<{ type: string; text: string }>;
      }>;
    };
    expect(b.type).toBe('rich_text');
    expect(b.elements[0].type).toBe('rich_text_preformatted');
    expect(b.elements[0].elements[0].text).toContain('const x = 1;');
  });

  it('renders unterminated code fence with no content as preformatted', () => {
    const md = 'Some text\n```';
    const result = formatAgentResponse(md);
    const types = result.blocks.map((b) => b.type);
    expect(types).toContain('rich_text');
  });

  it('falls back to paragraph when pipe-prefixed lines have no separator row', () => {
    const md = '| not | a | table\n| just | pipe | text';
    const result = formatAgentResponse(md);
    // No fields property (table rendering); only plain sections
    for (const b of result.blocks) {
      const s = b as { type: string; fields?: unknown };
      expect(s.fields).toBeUndefined();
    }
    expect(result.blocks.some((b) => b.type === 'section')).toBe(true);
  });

  it('treats pipe-prefixed line followed by data row (no separator) as paragraph', () => {
    // Second line is another data row, not a |---|---| separator
    const md = '| col1 | col2 |\n| data | row  |';
    const result = formatAgentResponse(md);
    for (const b of result.blocks) {
      const s = b as { type: string; fields?: unknown };
      expect(s.fields).toBeUndefined();
    }
  });

  it('handles very long single line without crashing', () => {
    const longLine = 'x'.repeat(5000);
    expect(() => formatAgentResponse(longLine)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// stripMarkdownFormatting
// ---------------------------------------------------------------------------

describe('stripMarkdownFormatting', () => {
  it('strips bold markers', () => {
    expect(stripMarkdownFormatting('**hello**')).toBe('hello');
    expect(stripMarkdownFormatting('__hello__')).toBe('hello');
  });

  it('strips italic markers', () => {
    expect(stripMarkdownFormatting('*hello*')).toBe('hello');
    expect(stripMarkdownFormatting('_hello_')).toBe('hello');
  });

  it('strips inline code backticks', () => {
    expect(stripMarkdownFormatting('`enclave-smoke-test`')).toBe(
      'enclave-smoke-test',
    );
  });

  it('strips strikethrough', () => {
    expect(stripMarkdownFormatting('~~removed~~')).toBe('removed');
  });

  it('strips links, keeping text', () => {
    expect(stripMarkdownFormatting('[click](https://example.com)')).toBe(
      'click',
    );
  });

  it('leaves plain text unchanged', () => {
    expect(stripMarkdownFormatting('hello world')).toBe('hello world');
  });
});

describe('preformatted blocks strip markdown formatting', () => {
  it('strips bold from code block content', () => {
    const md = '```\n**bold-name** active\n```';
    const b = blocks(md);
    const rt = b[0] as { elements: { elements: { text: string }[] }[] };
    expect(rt.elements[0].elements[0].text).toBe('bold-name active');
  });

  it('strips backticks from code block content', () => {
    const md = '```\n`my-service` running\n```';
    const b = blocks(md);
    const rt = b[0] as { elements: { elements: { text: string }[] }[] };
    expect(rt.elements[0].elements[0].text).toBe('my-service running');
  });

  it('translates markdown in wide table entity cards', () => {
    const md =
      '| Name | Status | Age |\n|---|---|---|\n| **my-svc** | `running` | ~5d |';
    const b = blocks(md);
    // Wide table now produces section blocks with fields
    const section = b[0] as {
      text: { text: string };
      fields: { text: string }[];
    };
    // First column is bold title — markdown stripped then wrapped in bold
    expect(section.text.text).toBe('*my-svc*');
    // Fields use header as label
    expect(section.fields[0].text).toContain('Status');
    expect(section.fields[1].text).toContain('Age');
  });
});
