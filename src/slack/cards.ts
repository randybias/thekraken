/**
 * Slack Block Kit card builders.
 *
 * Pure-function module: structured data in, Block Kit blocks out.
 * No side effects, no Slack API calls.
 */
import type { KnownBlock } from '@slack/types';

// ---------------------------------------------------------------------------
// Shared return type
// ---------------------------------------------------------------------------

export interface CardResult {
  blocks: KnownBlock[];
  text: string;
}

// ---------------------------------------------------------------------------
// Inline markdown stripper
// (formatter.ts is ported separately; cards only need this one helper)
// ---------------------------------------------------------------------------

function stripMarkdownFormatting(text: string): string {
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
// Shared helpers
// ---------------------------------------------------------------------------

function headerBlock(text: string): KnownBlock {
  const truncated = text.length > 150 ? text.slice(0, 147) + '...' : text;
  return {
    type: 'header',
    text: { type: 'plain_text', text: truncated, emoji: true },
  };
}

function sectionBlock(text: string): KnownBlock {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text },
  };
}

function dividerBlock(): KnownBlock {
  return { type: 'divider' };
}

function contextBlock(text: string): KnownBlock {
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text }],
  };
}

function richTextPreformatted(text: string): KnownBlock {
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

function urlButton(label: string, url: string): KnownBlock {
  // Defense-in-depth: Slack rejects non-https URLs, but validate anyway
  const safeUrl = url.startsWith('https://') ? url : '#';
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: `<${safeUrl}|${label}>` },
    accessory: {
      type: 'button',
      text: { type: 'plain_text', text: label, emoji: true },
      url: safeUrl,
    },
  };
}

// ---------------------------------------------------------------------------
// Status emoji mapping
// ---------------------------------------------------------------------------

const STATUS_EMOJI: Record<string, string> = {
  running: ':large_green_circle:',
  ready: ':large_green_circle:',
  healthy: ':large_green_circle:',
  degraded: ':large_yellow_circle:',
  pending: ':large_yellow_circle:',
  warning: ':large_yellow_circle:',
  failed: ':red_circle:',
  error: ':red_circle:',
  down: ':red_circle:',
  stopped: ':white_circle:',
  unknown: ':white_circle:',
};

function statusEmoji(status: string): string {
  return STATUS_EMOJI[status.toLowerCase()] ?? ':white_circle:';
}

// ---------------------------------------------------------------------------
// enclaveListCard
// ---------------------------------------------------------------------------

export interface EnclaveInfo {
  name: string;
  platform: string;
  members: string[];
  role: string;
}

export function enclaveListCard(
  enclaves: EnclaveInfo[],
  chromaBaseUrl?: string,
): CardResult {
  const blocks: KnownBlock[] = [];

  blocks.push(headerBlock('Your Enclaves'));

  if (enclaves.length === 0) {
    blocks.push(sectionBlock('You have no active enclaves.'));
    blocks.push(
      contextBlock('Use `tntc enclave create` to provision a new enclave.'),
    );
    return {
      blocks,
      text: 'You have no active enclaves.',
    };
  }

  const count = enclaves.length;
  blocks.push(
    sectionBlock(
      `You have *${count} active ${count === 1 ? 'enclave' : 'enclaves'}*:`,
    ),
  );

  // Build monospace table
  const idxWidth = String(count).length;
  const nameWidth = Math.max(4, ...enclaves.map((e) => e.name.length));
  const membersWidth = Math.max(
    7,
    ...enclaves.map((e) => String(e.members.length).length + 9), // "N members"
  );
  const roleWidth = Math.max(4, ...enclaves.map((e) => e.role.length));

  function row(
    idx: string,
    name: string,
    members: string,
    role: string,
  ): string {
    return [
      idx.padStart(idxWidth),
      name.padEnd(nameWidth),
      members.padEnd(membersWidth),
      role.padEnd(roleWidth),
    ].join('  ');
  }

  const separator = [
    '-'.repeat(idxWidth),
    '-'.repeat(nameWidth),
    '-'.repeat(membersWidth),
    '-'.repeat(roleWidth),
  ].join('  ');

  const tableLines = [
    row('#', 'Name', 'Members', 'Role'),
    separator,
    ...enclaves.map((e, i) =>
      row(
        String(i + 1),
        e.name,
        `${e.members.length} member${e.members.length !== 1 ? 's' : ''}`,
        e.role,
      ),
    ),
  ];

  blocks.push(richTextPreformatted(tableLines.join('\n')));
  blocks.push(dividerBlock());

  const ownerCount = enclaves.filter((e) => e.role === 'owner').length;
  const memberCount = enclaves.filter((e) => e.role === 'member').length;
  const parts: string[] = [];
  if (ownerCount > 0) parts.push(`*${ownerCount}* owned by you`);
  if (memberCount > 0) parts.push(`*${memberCount}* as member`);
  blocks.push(sectionBlock(parts.join(', ')));

  if (chromaBaseUrl && enclaves.length <= 5) {
    for (const enclave of enclaves) {
      const enclaveUrl = `${chromaBaseUrl}/enclaves/${enclave.name}`;
      blocks.push(urlButton(`Open ${enclave.name} in Chroma`, enclaveUrl));
    }
  } else if (chromaBaseUrl) {
    blocks.push(urlButton('View all enclaves in Chroma', chromaBaseUrl));
  }

  blocks.push(
    contextBlock('Use `tntc enclave info <name>` for details on any enclave.'),
  );

  const text = [
    `Your Enclaves (${count}):`,
    ...enclaves.map(
      (e, i) =>
        `${i + 1}. ${e.name} — ${e.members.length} member(s), role: ${e.role}`,
    ),
  ].join('\n');

  return { blocks, text };
}

// ---------------------------------------------------------------------------
// workflowStatusCard
// ---------------------------------------------------------------------------

export interface WorkflowInfo {
  name: string;
  status: string;
  ready: boolean;
  version: string;
  age: string;
}

export function workflowStatusCard(
  workflows: WorkflowInfo[],
  enclaveName: string,
  chromaBaseUrl?: string,
): CardResult {
  const blocks: KnownBlock[] = [];

  blocks.push(headerBlock(`Workflows — ${enclaveName}`));

  if (workflows.length === 0) {
    blocks.push(sectionBlock(`No workflows deployed in *${enclaveName}*.`));
    blocks.push(
      contextBlock('Use `tntc deploy` to deploy a workflow to this enclave.'),
    );
    return {
      blocks,
      text: `No workflows deployed in ${enclaveName}.`,
    };
  }

  for (let i = 0; i < workflows.length; i++) {
    if (i > 0) blocks.push(dividerBlock());

    const wf = workflows[i];
    const emoji = statusEmoji(wf.status);
    const readyText = wf.ready ? ':white_check_mark: Ready' : ':x: Not ready';

    blocks.push({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Name*\n\`${wf.name}\`` },
        {
          type: 'mrkdwn',
          text: `*Status*\n${emoji} ${wf.status}`,
        },
        { type: 'mrkdwn', text: `*Ready*\n${readyText}` },
        { type: 'mrkdwn', text: `*Version*\n${wf.version}` },
        { type: 'mrkdwn', text: `*Age*\n${wf.age}` },
      ],
    });
  }

  blocks.push(dividerBlock());

  const healthyCount = workflows.filter((w) => w.ready).length;
  blocks.push(
    sectionBlock(
      `*${healthyCount}/${workflows.length}* workflows ready in *${enclaveName}*`,
    ),
  );

  if (chromaBaseUrl) {
    const enclaveUrl = `${chromaBaseUrl}/enclaves/${enclaveName}`;
    blocks.push(urlButton(`View ${enclaveName} in Chroma`, enclaveUrl));
  }

  blocks.push(
    contextBlock(
      'Use `tntc status <workflow>` for detailed workflow information.',
    ),
  );

  const text = [
    `Workflows in ${enclaveName}:`,
    ...workflows.map(
      (w) =>
        `- ${w.name}: ${w.status} (ready: ${w.ready ? 'yes' : 'no'}, v${w.version}, age: ${w.age})`,
    ),
  ].join('\n');

  return { blocks, text };
}

// ---------------------------------------------------------------------------
// healthCard
// ---------------------------------------------------------------------------

export interface HealthSummary {
  total: number;
  healthy: number;
  degraded: number;
  down: number;
  details?: string;
}

export function healthCard(summary: HealthSummary): CardResult {
  const blocks: KnownBlock[] = [];

  blocks.push({
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: `*Total*\n${summary.total}` },
      {
        type: 'mrkdwn',
        text: `:large_green_circle: *Healthy*\n${summary.healthy}`,
      },
      {
        type: 'mrkdwn',
        text: `:large_yellow_circle: *Degraded*\n${summary.degraded}`,
      },
      {
        type: 'mrkdwn',
        text: `:red_circle: *Down*\n${summary.down}`,
      },
    ],
  });

  if (summary.details) {
    blocks.push(dividerBlock());
    blocks.push(sectionBlock(summary.details));
  }

  const text = `Health: ${summary.healthy}/${summary.total} healthy, ${summary.degraded} degraded, ${summary.down} down`;

  return { blocks, text };
}

// ---------------------------------------------------------------------------
// authCard
// ---------------------------------------------------------------------------

export interface AuthCardParams {
  loginUrl: string;
  userCode: string;
  expiresInSeconds: number;
}

export function authCard(params: AuthCardParams): CardResult {
  const { loginUrl, userCode, expiresInSeconds } = params;

  const blocks: KnownBlock[] = [];

  blocks.push(
    sectionBlock(
      'To authenticate, visit the URL below and enter your device code:',
    ),
  );

  blocks.push(sectionBlock(`Your device code:\n\`\`\`\n${userCode}\n\`\`\``));

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: 'Click the button to open the login page:' },
    accessory: {
      type: 'button',
      text: { type: 'plain_text', text: 'Log In', emoji: true },
      url: loginUrl,
      style: 'primary',
    },
  });

  const minutes = Math.ceil(expiresInSeconds / 60);
  blocks.push(
    contextBlock(
      `:hourglass: This code expires in *${minutes} minute${minutes !== 1 ? 's' : ''}*. Do not share it.`,
    ),
  );

  const text = `Authentication required. Visit ${loginUrl} and enter code: ${userCode} (expires in ${minutes} min)`;

  return { blocks, text };
}

// ---------------------------------------------------------------------------
// buildCard dispatcher
// ---------------------------------------------------------------------------

export type CardType = 'enclave_list' | 'workflow_status' | 'health' | 'auth';

export function buildCard(
  cardType: CardType | string,
  cardData: unknown,
  chromaBaseUrl?: string,
): CardResult {
  try {
    switch (cardType) {
      case 'enclave_list': {
        const data = cardData as { enclaves: EnclaveInfo[] };
        return enclaveListCard(data.enclaves ?? [], chromaBaseUrl);
      }
      case 'workflow_status': {
        const data = cardData as {
          workflows: WorkflowInfo[];
          enclave_name: string;
        };
        return workflowStatusCard(
          data.workflows ?? [],
          data.enclave_name ?? '',
          chromaBaseUrl,
        );
      }
      case 'health': {
        const data = cardData as HealthSummary;
        return healthCard(data);
      }
      case 'auth': {
        const data = cardData as AuthCardParams;
        return authCard(data);
      }
      default: {
        const raw =
          typeof cardData === 'string'
            ? cardData
            : JSON.stringify(cardData, null, 2);
        return {
          blocks: [sectionBlock(raw)],
          text: raw,
        };
      }
    }
  } catch {
    // Fall back to raw JSON display for any error
    const raw = typeof cardData === 'string' ? cardData : String(cardData);
    return {
      blocks: [sectionBlock(`Unable to render card (${cardType}):\n${raw}`)],
      text: raw,
    };
  }
}
