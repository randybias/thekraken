import { logger } from '../logger.js';

export interface ProvisionParams {
  name: string;
  ownerEmail: string;
  ownerSub: string;
  platform?: string;
  channelId?: string;
  channelName?: string;
  members?: string[];
  quotaPreset?: string;
  defaultMode?: string;
}

export interface ProvisionResult {
  name: string;
  status: string;
  [key: string]: unknown;
}

export interface DeprovisionResult {
  tentacles_removed: number;
  [key: string]: unknown;
}

type McpCall = (
  tool: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

export async function provisionEnclave(
  params: ProvisionParams,
  mcpCall: McpCall,
): Promise<ProvisionResult> {
  const mcpParams: Record<string, unknown> = {
    name: params.name,
    owner_email: params.ownerEmail,
    owner_sub: params.ownerSub,
  };
  if (params.platform) mcpParams.platform = params.platform;
  if (params.channelId) mcpParams.channel_id = params.channelId;
  if (params.channelName) mcpParams.channel_name = params.channelName;
  if (params.members) mcpParams.members = params.members;
  if (params.quotaPreset) mcpParams.quota_preset = params.quotaPreset;
  if (params.defaultMode) mcpParams.default_mode = params.defaultMode;

  logger.info(
    { enclave: params.name, owner: params.ownerEmail },
    'Provisioning enclave',
  );
  const result = await mcpCall('enclave_provision', mcpParams);
  return result as ProvisionResult;
}

export async function deprovisionEnclave(
  name: string,
  mcpCall: McpCall,
): Promise<DeprovisionResult> {
  logger.info({ enclave: name }, 'Deprovisioning enclave');
  const result = await mcpCall('enclave_deprovision', { name });
  return result as DeprovisionResult;
}
