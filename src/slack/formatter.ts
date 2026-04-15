/**
 * Slack Block Kit formatter.
 *
 * Pure-function module: markdown in, Block Kit blocks out.
 * No side effects, no Slack API calls.
 */
import type { KnownBlock } from '@slack/types';

export interface FormattedMessage {
  blocks: KnownBlock[];
  text: string;
  overflow?: KnownBlock[][];
}

// ---------------------------------------------------------------------------
// Segment types produced by the line-by-line state machine
// ---------------------------------------------------------------------------

interface CodeSegment {
  type: 'code';
  lang: string;
  lines: string[];
}

interface TableSegment {
  type: 'table';
  headers: string[];
  rows: string[][];
}

interface HeaderSegment {
  type: 'header';
  level: 1 | 2 | 3;
  text: string;
}

interface HrSegment {
  type: 'hr';
}

interface ListSegment {
  type: 'list';
  items: string[];
}

interface ParagraphSegment {
  type: 'paragraph';
  lines: string[];
}

type Segment =
  | CodeSegment
  | TableSegment
  | HeaderSegment
  | HrSegment
  | ListSegment
  | ParagraphSegment;

// ---------------------------------------------------------------------------
// Strip markdown formatting for preformatted/monospace contexts
// ---------------------------------------------------------------------------

export function stripMarkdownFormatting(text: string): string {
  // Bold: **text** or __text__ -> text
  text = text.replace(/__([^_\n]+)__/g, '$1');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1');

  // Italic: *text* or _text_ -> text (but not inside words like don't)
  text = text.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1');
  text = text.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1');

  // Strikethrough: ~~text~~ -> text
  text = text.replace(/~~([^~\n]+)~~/g, '$1');

  // Inline code: `text` -> text
  text = text.replace(/`([^`\n]+)`/g, '$1');

  // Links: [text](url) -> text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  return text;
}

// ---------------------------------------------------------------------------
// Inline mrkdwn translation
// ---------------------------------------------------------------------------

export function translateToMrkdwn(text: string): string {
  // Bold: **text** or __text__ -> *text*
  // Process __bold__ before **bold** to avoid partial replacement issues
  text = text.replace(/__([^_\n]+)__/g, '*$1*');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');

  // Strikethrough: ~~text~~ -> ~text~
  text = text.replace(/~~([^~\n]+)~~/g, '~$1~');

  // Links: [text](url) -> <url|text>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  return text;
}

// ---------------------------------------------------------------------------
// Line-by-line state machine parser
// ---------------------------------------------------------------------------

function parseMarkdown(markdown: string): Segment[] {
  const lines = markdown.split('\n');
  const segments: Segment[] = [];

  let i = 0;
  let inCode = false;
  let codeLang = '';
  let codeLines: string[] = [];

  // Accumulator for paragraph lines
  let paragraphLines: string[] = [];

  function flushParagraph(): void {
    if (paragraphLines.length > 0) {
      segments.push({ type: 'paragraph', lines: [...paragraphLines] });
      paragraphLines = [];
    }
  }

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // --- Code block (fenced) ---
    if (!inCode && /^```/.test(line)) {
      flushParagraph();
      inCode = true;
      codeLang = line.slice(3).trim();
      codeLines = [];
      i++;
      continue;
    }

    if (inCode) {
      if (/^```/.test(line)) {
        // Close code block
        segments.push({ type: 'code', lang: codeLang, lines: codeLines });
        inCode = false;
        codeLines = [];
        codeLang = '';
      } else {
        codeLines.push(line);
      }
      i++;
      continue;
    }

    // --- Horizontal rule ---
    if (/^(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushParagraph();
      segments.push({ type: 'hr' });
      i++;
      continue;
    }

    // --- Headers ---
    const headerMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headerMatch) {
      flushParagraph();
      const level = Math.min(headerMatch[1]!.length, 3) as 1 | 2 | 3;
      segments.push({ type: 'header', level, text: headerMatch[2]!.trim() });
      i++;
      continue;
    }

    // --- Table ---
    // A table starts with | and must have a proper separator row on line 2
    // (e.g. |---|---|). If no valid separator, fall back to paragraph lines.
    if (line.startsWith('|')) {
      const separatorLine = lines[i + 1];
      const hasSeparator =
        separatorLine !== undefined &&
        separatorLine.startsWith('|') &&
        /^\|[\s|:-]+\|/.test(separatorLine);

      if (hasSeparator) {
        flushParagraph();
        const tableLines: string[] = [];
        while (i < lines.length && (lines[i] ?? '').startsWith('|')) {
          tableLines.push(lines[i]!);
          i++;
        }
        const tableSegment = parseTable(tableLines);
        if (tableSegment) {
          segments.push(tableSegment);
        } else {
          // parseTable rejected it — treat as paragraph lines
          for (const tl of tableLines) {
            paragraphLines.push(tl);
          }
        }
      } else {
        // No separator row — not a table, treat as paragraph text
        paragraphLines.push(line);
        i++;
      }
      continue;
    }

    // --- List items ---
    if (/^(\s*[-*]\s|\s*\d+\.\s)/.test(line)) {
      flushParagraph();
      const listItems: string[] = [];
      while (
        i < lines.length &&
        /^(\s*[-*]\s|\s*\d+\.\s)/.test(lines[i] ?? '')
      ) {
        listItems.push(lines[i]!);
        i++;
      }
      segments.push({ type: 'list', items: listItems });
      continue;
    }

    // --- Blank lines ---
    if (line.trim() === '') {
      flushParagraph();
      i++;
      continue;
    }

    // --- Paragraph text ---
    paragraphLines.push(line);
    i++;
  }

  // If code block was never closed (truncated response), emit what we have
  if (inCode) {
    segments.push({ type: 'code', lang: codeLang, lines: codeLines });
  }

  flushParagraph();

  return segments;
}

function parseTable(tableLines: string[]): TableSegment | null {
  if (tableLines.length < 2) return null;

  // Parse a pipe-separated row into cells, trimming whitespace
  function parseRow(line: string): string[] {
    return line
      .split('|')
      .map((c) => c.trim())
      .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
  }

  const headers = parseRow(tableLines[0] ?? '');
  if (headers.length === 0) return null;

  // Second line must be a separator row (---|---); reject if not
  const sep = tableLines[1];
  if (!sep || !/^\|[\s|:-]+\|/.test(sep)) return null;

  // Skip separator, parse data rows
  const dataLines = tableLines.slice(2);
  const rows: string[][] = dataLines.map(parseRow);

  return { type: 'table', headers, rows };
}

// ---------------------------------------------------------------------------
// Block Kit block builders
// ---------------------------------------------------------------------------

const SECTION_TEXT_LIMIT = 2800;

function buildHeaderBlock(text: string): KnownBlock {
  const truncated = text.length > 150 ? text.slice(0, 147) + '...' : text;
  return {
    type: 'header',
    text: { type: 'plain_text', text: truncated, emoji: true },
  };
}

function buildSectionBlock(text: string): KnownBlock {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text },
  };
}

function buildDividerBlock(): KnownBlock {
  return { type: 'divider' };
}

function buildRichTextPreformatted(text: string): KnownBlock {
  return {
    type: 'rich_text',
    elements: [
      {
        type: 'rich_text_preformatted',
        elements: [{ type: 'text', text: stripMarkdownFormatting(text) }],
      },
    ],
  };
}

// Split long text into multiple section blocks at line boundaries
function buildSectionBlocks(text: string): KnownBlock[] {
  if (text.length <= SECTION_TEXT_LIMIT) {
    return [buildSectionBlock(text)];
  }

  const blocks: KnownBlock[] = [];
  const lines = text.split('\n');
  let chunk = '';

  for (const line of lines) {
    const candidate = chunk ? chunk + '\n' + line : line;
    if (candidate.length > SECTION_TEXT_LIMIT) {
      if (chunk) {
        blocks.push(buildSectionBlock(chunk));
        chunk = line;
      } else {
        // Single line exceeds limit — hard truncate
        blocks.push(buildSectionBlock(line.slice(0, SECTION_TEXT_LIMIT)));
        chunk = '';
      }
    } else {
      chunk = candidate;
    }
  }

  if (chunk) {
    blocks.push(buildSectionBlock(chunk));
  }

  return blocks;
}

function segmentToBlocks(segment: Segment): KnownBlock[] {
  switch (segment.type) {
    case 'hr':
      return [buildDividerBlock()];

    case 'header': {
      if (segment.level === 1) {
        return [buildHeaderBlock(segment.text)];
      }
      // ## and ### -> bold section
      const prefix = segment.level === 2 ? '*' : '_*';
      const suffix = segment.level === 2 ? '*' : '*_';
      const translated = translateToMrkdwn(segment.text);
      return [buildSectionBlock(`${prefix}${translated}${suffix}`)];
    }

    case 'code': {
      const codeText = segment.lines.join('\n');
      return [buildRichTextPreformatted(codeText)];
    }

    case 'table': {
      const { headers, rows } = segment;
      if (headers.length === 2) {
        return buildTwoColumnTableBlocks(headers, rows);
      }
      return buildWideTableBlocks(headers, rows);
    }

    case 'list': {
      const mrkdwnLines = segment.items.map((item) => {
        // Normalise bullet/numbered to mrkdwn bullets
        const stripped = item.replace(/^\s*(?:[-*]|\d+\.)\s/, '');
        return `• ${translateToMrkdwn(stripped)}`;
      });
      return buildSectionBlocks(mrkdwnLines.join('\n'));
    }

    case 'paragraph': {
      const text = translateToMrkdwn(segment.lines.join('\n'));
      return buildSectionBlocks(text);
    }
  }
}

// 2-column table: section blocks with fields (max 10 fields per block).
// The first block includes 2 header fields, so it can hold only 4 data rows
// (2 + 4×2 = 10). Subsequent blocks have no header and hold 5 data rows (10).
function buildTwoColumnTableBlocks(
  headers: string[],
  rows: string[][],
): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  const ROWS_FIRST_BLOCK = 4; // 2 header fields + 4×2 = 10 total
  const ROWS_PER_BLOCK = 5; // no header fields: 5×2 = 10 total

  let start = 0;
  while (start < rows.length) {
    const isFirst = start === 0;
    const limit = isFirst ? ROWS_FIRST_BLOCK : ROWS_PER_BLOCK;
    const chunk = rows.slice(start, start + limit);
    start += limit;
    const fields = [
      // Header row (bold) only on the first block
      ...(isFirst
        ? headers.map((h) => ({
            type: 'mrkdwn' as const,
            text: `*${translateToMrkdwn(h)}*`,
          }))
        : []),
      ...chunk.flatMap((row) =>
        row.slice(0, 2).map((cell) => ({
          type: 'mrkdwn' as const,
          text: translateToMrkdwn(cell),
        })),
      ),
    ];

    if (fields.length > 0) {
      blocks.push({
        type: 'section',
        fields,
      });
    }
  }

  return blocks;
}

// 3+ column table: stacked entity cards using section blocks with fields.
// Each row becomes a section where the first column is the title (bold)
// and remaining columns are label:value field pairs. This renders
// responsively on both desktop and mobile (fields stack on narrow screens).
function buildWideTableBlocks(
  headers: string[],
  rows: string[][],
): KnownBlock[] {
  const blocks: KnownBlock[] = [];

  for (const row of rows) {
    // First column is the entity name (bold section text).
    // Strip markdown first so we don't double-wrap bold markers.
    const title = translateToMrkdwn(stripMarkdownFormatting(row[0] ?? ''));

    // Remaining columns become label:value fields (max 10 per section)
    const fields: { type: 'mrkdwn'; text: string }[] = [];
    for (let i = 1; i < headers.length && i < row.length; i++) {
      const label = translateToMrkdwn(headers[i] ?? '');
      const value = translateToMrkdwn(row[i] ?? '');
      fields.push({ type: 'mrkdwn', text: `*${label}:* ${value}` });
    }

    if (fields.length > 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${title}*` },
        fields: fields.slice(0, 10),
      });
    } else {
      blocks.push(buildSectionBlock(`*${title}*`));
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Plain-text fallback generator
// ---------------------------------------------------------------------------

function generatePlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, '[code block]')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s/gm, '- ')
    .replace(/^\s*\d+\.\s/gm, '')
    .replace(/^(---+|\*\*\*+|___+)\s*$/gm, '---')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

const MAX_BLOCKS_PER_MESSAGE = 50;

export function formatAgentResponse(markdown: string): FormattedMessage {
  if (!markdown || markdown.trim() === '') {
    return {
      blocks: [buildSectionBlock(markdown || ' ')],
      text: markdown || '',
    };
  }

  const segments = parseMarkdown(markdown);
  const allBlocks: KnownBlock[] = segments.flatMap(segmentToBlocks);
  const text = generatePlainText(markdown);

  if (allBlocks.length <= MAX_BLOCKS_PER_MESSAGE) {
    return { blocks: allBlocks, text };
  }

  // Split into batches of 50
  const blocks = allBlocks.slice(0, MAX_BLOCKS_PER_MESSAGE);
  const overflow: KnownBlock[][] = [];
  for (
    let start = MAX_BLOCKS_PER_MESSAGE;
    start < allBlocks.length;
    start += MAX_BLOCKS_PER_MESSAGE
  ) {
    overflow.push(allBlocks.slice(start, start + MAX_BLOCKS_PER_MESSAGE));
  }

  return { blocks, text, overflow };
}
