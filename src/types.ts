/**
 * Shared type definitions for The Kraken.
 */

/** An active channel-to-enclave binding from the enclave_bindings SQLite table. */
export interface EnclaveBinding {
  /** Slack channel ID. */
  channelId: string;
  /** Enclave / Kubernetes namespace name. */
  enclaveName: string;
  /** Slack user ID of the enclave owner. */
  ownerSlackId: string;
  /** Binding status. Only 'active' bindings are returned. */
  status: 'active';
  /** ISO 8601 timestamp when the binding was created. */
  createdAt: string;
}

/** Context for a message dispatched to the agent runner. */
export interface MessageContext {
  /** Enclave name for enclave-mode messages, null for DM mode. */
  enclaveName: string | null;
  /** Slack user ID of the message sender. */
  slackUserId: string;
  /** Whether this is an enclave channel message or a direct message. */
  mode: 'enclave' | 'dm';
}
