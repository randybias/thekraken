/**
 * Prompt and template iteration commands.
 *
 * Commands:
 *   @kraken show prompts [workflow]         — list all prompts in a workflow
 *   @kraken show prompt <workflow> <name>   — show full prompt text
 *   @kraken show templates [workflow]       — list all templates in a workflow
 *   @kraken show template <workflow> <name> — show full template text
 *
 * These commands call wf_describe to fetch prompt/template metadata from
 * the deployed workflow's prompts.yaml (stored in Tier 2 ConfigMap by the
 * builder). The metadata pipeline (Plan B2) must be deployed for these
 * commands to return data.
 */

import { logger } from '../../logger.js';
import type { CommandContext } from '../commands.js';

interface PromptTool {
  name: string;
  description?: string;
}

interface PromptEntry {
  node: string;
  name: string;
  description?: string;
  model?: string;
  system_prompt?: string;
  user_prompt_template?: string;
  tools?: PromptTool[];
}

interface TemplateEntry {
  node: string;
  name: string;
  description?: string;
  format?: string;
  template?: string;
}

interface WfDescribeResult {
  name?: string;
  namespace?: string;
  prompts?: PromptEntry[];
  templates?: TemplateEntry[];
}

/**
 * Fetch workflow description with prompt/template metadata.
 * Returns null if the workflow is not found or has no metadata.
 */
async function fetchWorkflowMetadata(
  workflowName: string,
  ctx: CommandContext,
): Promise<WfDescribeResult | null> {
  try {
    const result = (await ctx.mcpCall('wf_describe', {
      enclave: ctx.enclaveName,
      name: workflowName,
    })) as WfDescribeResult;
    return result ?? null;
  } catch (err) {
    logger.debug(
      { workflow: workflowName, err },
      'prompts: wf_describe failed',
    );
    return null;
  }
}

/**
 * List all workflows in the enclave (for when no workflow name is given).
 */
async function listWorkflows(ctx: CommandContext): Promise<string[]> {
  try {
    const result = (await ctx.mcpCall('wf_list', {
      enclave: ctx.enclaveName,
    })) as { workflows?: Array<{ name: string }> };
    return (result?.workflows ?? []).map((w) => w.name);
  } catch (err) {
    logger.debug({ err }, 'prompts: wf_list failed');
    return [];
  }
}

/**
 * @kraken show prompts [workflow]
 */
export async function handleShowPrompts(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  // If no workflow specified, list all workflows with prompt counts
  if (args.length === 0) {
    const workflows = await listWorkflows(ctx);
    if (workflows.length === 0) {
      await ctx.sendMessage('No workflows found in this enclave.');
      return;
    }

    const lines: string[] = ['*Workflows with prompts:*'];
    for (const wfName of workflows) {
      const meta = await fetchWorkflowMetadata(wfName, ctx);
      const promptCount = meta?.prompts?.length ?? 0;
      if (promptCount > 0) {
        lines.push(
          `• *${wfName}* — ${promptCount} prompt${promptCount !== 1 ? 's' : ''}`,
        );
      }
    }

    if (lines.length === 1) {
      await ctx.sendMessage(
        'No workflows have prompt metadata yet. Prompts are declared in `prompts.yaml` and captured during deploy.',
      );
      return;
    }

    lines.push('');
    lines.push('Say `show prompts <workflow>` to see details.');
    await ctx.sendMessage(lines.join('\n'));
    return;
  }

  const workflowName = args[0]!;
  const meta = await fetchWorkflowMetadata(workflowName, ctx);
  if (!meta) {
    await ctx.sendMessage(
      `Workflow *${workflowName}* not found in this enclave.`,
    );
    return;
  }

  const prompts = meta.prompts ?? [];
  if (prompts.length === 0) {
    await ctx.sendMessage(
      `*${workflowName}* has no prompt metadata. Add a \`prompts.yaml\` file to declare LLM prompts.`,
    );
    return;
  }

  const lines: string[] = [`*Prompts in ${workflowName}:*`];
  for (const p of prompts) {
    const model = p.model ? ` (${p.model})` : '';
    const toolCount = p.tools?.length ?? 0;
    const tools =
      toolCount > 0 ? ` | ${toolCount} tool${toolCount !== 1 ? 's' : ''}` : '';
    lines.push(`• *${p.name}* → node \`${p.node}\`${model}${tools}`);
    if (p.description) {
      lines.push(`  _${p.description}_`);
    }
  }

  lines.push('');
  lines.push(
    `Say \`show prompt ${workflowName} <name>\` to see the full text.`,
  );
  await ctx.sendMessage(lines.join('\n'));
}

/**
 * @kraken show prompt <workflow> <name>
 */
export async function handleShowPrompt(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  if (args.length < 2) {
    await ctx.sendMessage(
      'Usage: `show prompt <workflow> <prompt-name>`\nSay `show prompts` to see available prompts.',
    );
    return;
  }

  const [workflowName, promptName] = args as [string, string];
  const meta = await fetchWorkflowMetadata(workflowName, ctx);
  if (!meta) {
    await ctx.sendMessage(
      `Workflow *${workflowName}* not found in this enclave.`,
    );
    return;
  }

  const prompt = (meta.prompts ?? []).find(
    (p) => p.name === promptName || p.node === promptName,
  );
  if (!prompt) {
    const available = (meta.prompts ?? []).map((p) => p.name).join(', ');
    await ctx.sendMessage(
      `No prompt named *${promptName}* in *${workflowName}*.${available ? ` Available: ${available}` : ''}`,
    );
    return;
  }

  const lines: string[] = [`*${prompt.name}* (node: \`${prompt.node}\`)`];
  if (prompt.description) lines.push(`_${prompt.description}_`);
  if (prompt.model) lines.push(`Model: ${prompt.model}`);

  if (prompt.system_prompt) {
    const truncated =
      prompt.system_prompt.length > 3000
        ? prompt.system_prompt.slice(0, 3000) + '\n...(truncated)'
        : prompt.system_prompt;
    lines.push('');
    lines.push('*System prompt:*');
    lines.push('```');
    lines.push(truncated);
    lines.push('```');
  }

  if (prompt.user_prompt_template) {
    lines.push('');
    lines.push('*User prompt template:*');
    lines.push('```');
    lines.push(prompt.user_prompt_template);
    lines.push('```');
  }

  if (prompt.tools && prompt.tools.length > 0) {
    lines.push('');
    lines.push('*Tools:*');
    for (const t of prompt.tools) {
      lines.push(
        `• \`${t.name}\`${t.description ? ` — ${t.description}` : ''}`,
      );
    }
  }

  await ctx.sendMessage(lines.join('\n'));
}

/**
 * @kraken show templates [workflow]
 */
export async function handleShowTemplates(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  if (args.length === 0) {
    const workflows = await listWorkflows(ctx);
    if (workflows.length === 0) {
      await ctx.sendMessage('No workflows found in this enclave.');
      return;
    }

    const lines: string[] = ['*Workflows with templates:*'];
    for (const wfName of workflows) {
      const meta = await fetchWorkflowMetadata(wfName, ctx);
      const templateCount = meta?.templates?.length ?? 0;
      if (templateCount > 0) {
        lines.push(
          `• *${wfName}* — ${templateCount} template${templateCount !== 1 ? 's' : ''}`,
        );
      }
    }

    if (lines.length === 1) {
      await ctx.sendMessage(
        'No workflows have template metadata yet. Templates are declared in `prompts.yaml` and captured during deploy.',
      );
      return;
    }

    lines.push('');
    lines.push('Say `show templates <workflow>` to see details.');
    await ctx.sendMessage(lines.join('\n'));
    return;
  }

  const workflowName = args[0]!;
  const meta = await fetchWorkflowMetadata(workflowName, ctx);
  if (!meta) {
    await ctx.sendMessage(
      `Workflow *${workflowName}* not found in this enclave.`,
    );
    return;
  }

  const templates = meta.templates ?? [];
  if (templates.length === 0) {
    await ctx.sendMessage(
      `*${workflowName}* has no template metadata. Add templates to \`prompts.yaml\` to declare output templates.`,
    );
    return;
  }

  const lines: string[] = [`*Templates in ${workflowName}:*`];
  for (const t of templates) {
    const fmt = t.format ? ` (${t.format})` : '';
    lines.push(`• *${t.name}* → node \`${t.node}\`${fmt}`);
    if (t.description) {
      lines.push(`  _${t.description}_`);
    }
  }

  lines.push('');
  lines.push(
    `Say \`show template ${workflowName} <name>\` to see the full text.`,
  );
  await ctx.sendMessage(lines.join('\n'));
}

/**
 * @kraken show template <workflow> <name>
 */
export async function handleShowTemplate(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  if (args.length < 2) {
    await ctx.sendMessage(
      'Usage: `show template <workflow> <template-name>`\nSay `show templates` to see available templates.',
    );
    return;
  }

  const [workflowName, templateName] = args as [string, string];
  const meta = await fetchWorkflowMetadata(workflowName, ctx);
  if (!meta) {
    await ctx.sendMessage(
      `Workflow *${workflowName}* not found in this enclave.`,
    );
    return;
  }

  const template = (meta.templates ?? []).find(
    (t) => t.name === templateName || t.node === templateName,
  );
  if (!template) {
    const available = (meta.templates ?? []).map((t) => t.name).join(', ');
    await ctx.sendMessage(
      `No template named *${templateName}* in *${workflowName}*.${available ? ` Available: ${available}` : ''}`,
    );
    return;
  }

  const lines: string[] = [`*${template.name}* (node: \`${template.node}\`)`];
  if (template.description) lines.push(`_${template.description}_`);
  if (template.format) lines.push(`Format: ${template.format}`);

  if (template.template) {
    const truncated =
      template.template.length > 3000
        ? template.template.slice(0, 3000) + '\n...(truncated)'
        : template.template;
    lines.push('');
    lines.push('*Template:*');
    lines.push('```');
    lines.push(truncated);
    lines.push('```');
  }

  await ctx.sendMessage(lines.join('\n'));
}
