/**
 * Slack App Home Tab Block Kit view builders.
 *
 * Pure-function module: structured data in, Home Tab view out.
 * No side effects, no Slack API calls.
 */
import type { KnownBlock } from '@slack/types';

// ---------------------------------------------------------------------------
// View type
// ---------------------------------------------------------------------------

export interface HomeView {
  type: 'home';
  blocks: KnownBlock[];
}

// ---------------------------------------------------------------------------
// EnclaveData interface
// ---------------------------------------------------------------------------

export interface EnclaveData {
  name: string;
  tentacleCount: number;
  healthyCount: number;
  role: 'owner' | 'member';
  chromaUrl?: string;
}

// ---------------------------------------------------------------------------
// Block helpers
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

function urlButtonSection(
  label: string,
  url: string,
  enclaveName: string,
): KnownBlock {
  const safeUrl = url.startsWith('https://') ? url : '#';
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: label, emoji: true },
        url: safeUrl,
        action_id: `open_chroma_${enclaveName}`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Health emoji helper
// ---------------------------------------------------------------------------

function healthEmoji(healthy: number, total: number): string {
  if (total === 0) return ':white_circle:';
  const ratio = healthy / total;
  if (ratio >= 1) return ':large_green_circle:';
  if (ratio >= 0.5) return ':large_yellow_circle:';
  return ':red_circle:';
}

// ---------------------------------------------------------------------------
// buildHomeTab
// ---------------------------------------------------------------------------

export function buildHomeTab(enclaves: EnclaveData[]): HomeView {
  const blocks: KnownBlock[] = [];

  blocks.push(headerBlock('Welcome to The Kraken'));

  blocks.push(
    sectionBlock(
      'The Kraken manages your automated workflows (tentacles) running in team workspaces (enclaves).',
    ),
  );

  blocks.push(dividerBlock());

  blocks.push(headerBlock('Your Enclaves'));

  if (enclaves.length === 0) {
    blocks.push(
      sectionBlock(
        "You don't have any enclaves yet. Ask a team admin to invite you, or create a new Slack channel and tell me to initialize it.",
      ),
    );
  } else {
    for (const enclave of enclaves) {
      const emoji = healthEmoji(enclave.healthyCount, enclave.tentacleCount);
      const tentacleLabel =
        enclave.tentacleCount === 1 ? 'tentacle' : 'tentacles';
      const roleLabel = enclave.role === 'owner' ? 'Owner' : 'Member';

      const fieldText = [
        `*${enclave.name}*`,
        `${emoji} ${enclave.tentacleCount} ${tentacleLabel}`,
        `Role: ${roleLabel}`,
      ].join('  |  ');

      blocks.push(sectionBlock(fieldText));

      if (enclave.chromaUrl) {
        blocks.push(
          urlButtonSection('Open in Chroma', enclave.chromaUrl, enclave.name),
        );
      }
    }
  }

  blocks.push(dividerBlock());

  blocks.push(headerBlock('Quick Reference'));
  blocks.push(
    contextBlock(
      'Tentacles = automated workflows | Enclaves = team workspaces | Chroma = detailed dashboard',
    ),
  );
  blocks.push(
    contextBlock(
      'Talk to me in any enclave channel, or DM me to check on things.',
    ),
  );

  return { type: 'home', blocks };
}

// ---------------------------------------------------------------------------
// buildUnauthenticatedHomeTab
// ---------------------------------------------------------------------------

export function buildUnauthenticatedHomeTab(): HomeView {
  const blocks: KnownBlock[] = [];

  blocks.push(headerBlock('Welcome to The Kraken'));

  blocks.push(
    sectionBlock(
      "I need to verify your identity before I can show your enclaves. Send me a DM and I'll walk you through a quick login.",
    ),
  );

  return { type: 'home', blocks };
}
