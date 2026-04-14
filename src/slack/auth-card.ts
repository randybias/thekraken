/**
 * Ephemeral Slack auth card for OIDC device flow prompts.
 *
 * Ephemeral messages are visible ONLY to the target user — other channel
 * members do not see the auth prompt. Uses chat.postEphemeral (not
 * chat.postMessage) for privacy.
 *
 * Three card types:
 *   postAuthCard   — initial prompt with verification URI + user code
 *   postAuthSuccess — success confirmation after device flow completes
 *   postAuthTimeout — timeout message if device code expires
 */

import type { WebClient } from '@slack/web-api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthCardParams {
  /** Slack channel ID. */
  channel: string;
  /** Slack user ID (card is visible only to this user). */
  userId: string;
  /** Keycloak verification URI. */
  verificationUri: string;
  /** User code to enter at verificationUri. */
  userCode: string;
  /** Seconds until the device code expires. */
  expiresIn: number;
}

// ---------------------------------------------------------------------------
// postAuthCard
// ---------------------------------------------------------------------------

/**
 * Post an ephemeral auth card to a Slack channel.
 *
 * Visible only to the target user. Prompts them to complete the OIDC
 * device flow before their message can be processed.
 */
export async function postAuthCard(
  client: WebClient,
  params: AuthCardParams,
): Promise<void> {
  await client.chat.postEphemeral({
    channel: params.channel,
    user: params.userId,
    text: `Please authenticate: visit ${params.verificationUri} and enter code ${params.userCode}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            ':lock: *Authentication Required*\n\n' +
            'I need to verify your identity before I can help. ' +
            'This only takes a moment.',
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Step 1:* Visit <${params.verificationUri}|this link>`,
          },
          {
            type: 'mrkdwn',
            text: `*Step 2:* Enter code \`${params.userCode}\``,
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `This code expires in ${Math.floor(params.expiresIn / 60)} minutes.`,
          },
        ],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// postAuthSuccess
// ---------------------------------------------------------------------------

/**
 * Post an ephemeral success message after the user completes device flow.
 */
export async function postAuthSuccess(
  client: WebClient,
  channel: string,
  userId: string,
): Promise<void> {
  await client.chat.postEphemeral({
    channel,
    user: userId,
    text: 'You are now authenticated. Your session will last 12 hours.',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            ':white_check_mark: *Authenticated*\n\n' +
            "You're all set. Your session lasts 12 hours. " +
            'Go ahead and ask me anything.',
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// postAuthTimeout
// ---------------------------------------------------------------------------

/**
 * Post an ephemeral timeout message if the device code expires.
 * Called when pollForToken() throws OidcFlowError with expired_token
 * or deadline_exceeded phase.
 */
export async function postAuthTimeout(
  client: WebClient,
  channel: string,
  userId: string,
): Promise<void> {
  await client.chat.postEphemeral({
    channel,
    user: userId,
    text: 'Authentication timed out. Please try again by sending me a message.',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            ':hourglass: *Authentication Timed Out*\n\n' +
            'The login code expired before you completed it. ' +
            "Just send me another message and I'll start a new one.",
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// postAuthDenial
// ---------------------------------------------------------------------------

/**
 * Post an ephemeral denial message when the authz check fails.
 * The reason string comes from checkAccess() denial messages (human-friendly).
 */
export async function postAuthDenial(
  client: WebClient,
  channel: string,
  userId: string,
  reason: string,
): Promise<void> {
  await client.chat.postEphemeral({
    channel,
    user: userId,
    text: reason,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:no_entry: ${reason}`,
        },
      },
    ],
  });
}
