/**
 * Persona inference for enclave teams (Phase 3).
 *
 * Infers a team persona from an enclave description using keyword matching
 * against 11 predefined archetypes. The inferred persona is stored in
 * MEMORY.md and influences how the agent communicates with that team.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Persona {
  name: string;
  languageLevel:
    | 'non-technical'
    | 'semi-technical'
    | 'technical'
    | 'highly-technical';
  technicalDetail: 'low' | 'medium' | 'high';
  suggestedScaffolds: string[];
  keywords: string[];
}

// ---------------------------------------------------------------------------
// Archetype definitions
// ---------------------------------------------------------------------------

export const ARCHETYPES: Persona[] = [
  {
    name: 'Marketing',
    languageLevel: 'non-technical',
    technicalDetail: 'low',
    suggestedScaffolds: [
      'content-pipeline',
      'social-media-analyzer',
      'campaign-tracker',
    ],
    keywords: [
      'marketing',
      'campaign',
      'content',
      'social',
      'brand',
      'audience',
      'seo',
      'analytics',
      'advertising',
      'promotion',
      'leads',
      'conversion',
      'email',
      'newsletter',
      'engagement',
      'growth',
      'funnel',
    ],
  },
  {
    name: 'Sales',
    languageLevel: 'non-technical',
    technicalDetail: 'low',
    suggestedScaffolds: ['crm-sync', 'pipeline-tracker', 'proposal-generator'],
    keywords: [
      'sales',
      'revenue',
      'pipeline',
      'prospect',
      'customer',
      'deal',
      'quota',
      'forecast',
      'account',
      'crm',
      'closing',
      'outreach',
      'leads',
      'conversion',
      'commission',
      'territory',
    ],
  },
  {
    name: 'Customer Support',
    languageLevel: 'non-technical',
    technicalDetail: 'low',
    suggestedScaffolds: ['ticket-processor', 'faq-bot', 'escalation-router'],
    keywords: [
      'support',
      'customer',
      'ticket',
      'helpdesk',
      'issue',
      'complaint',
      'resolution',
      'service',
      'satisfaction',
      'nps',
      'escalation',
      'sla',
      'onboarding',
      'feedback',
      'inquiry',
      'response',
    ],
  },
  {
    name: 'Operations',
    languageLevel: 'semi-technical',
    technicalDetail: 'medium',
    suggestedScaffolds: [
      'incident-responder',
      'runbook-executor',
      'status-reporter',
    ],
    keywords: [
      'operations',
      'ops',
      'process',
      'workflow',
      'automation',
      'runbook',
      'incident',
      'monitoring',
      'alert',
      'sre',
      'reliability',
      'uptime',
      'deployment',
      'release',
      'maintenance',
      'scheduling',
    ],
  },
  {
    name: 'IT',
    languageLevel: 'technical',
    technicalDetail: 'high',
    suggestedScaffolds: [
      'infra-auditor',
      'patch-tracker',
      'access-provisioner',
    ],
    keywords: [
      'it',
      'infrastructure',
      'server',
      'network',
      'security',
      'patch',
      'access',
      'provisioning',
      'compliance',
      'audit',
      'endpoint',
      'directory',
      'identity',
      'vpn',
      'firewall',
      'backup',
    ],
  },
  {
    name: 'Software Development',
    languageLevel: 'highly-technical',
    technicalDetail: 'high',
    suggestedScaffolds: ['code-reviewer', 'pr-summarizer', 'test-runner'],
    keywords: [
      'development',
      'engineering',
      'code',
      'software',
      'api',
      'backend',
      'frontend',
      'fullstack',
      'microservice',
      'repository',
      'pr',
      'review',
      'testing',
      'ci',
      'cd',
      'sprint',
      'agile',
      'debugging',
    ],
  },
  {
    name: 'Architecture',
    languageLevel: 'highly-technical',
    technicalDetail: 'high',
    suggestedScaffolds: [
      'diagram-generator',
      'adr-writer',
      'dependency-analyzer',
    ],
    keywords: [
      'architecture',
      'design',
      'system',
      'scalability',
      'pattern',
      'diagram',
      'adr',
      'decision',
      'trade-off',
      'distributed',
      'event-driven',
      'service',
      'platform',
      'technical',
      'specification',
      'blueprint',
    ],
  },
  {
    name: 'Finance',
    languageLevel: 'semi-technical',
    technicalDetail: 'medium',
    suggestedScaffolds: [
      'report-generator',
      'budget-tracker',
      'expense-analyzer',
    ],
    keywords: [
      'finance',
      'budget',
      'accounting',
      'expense',
      'invoice',
      'revenue',
      'cost',
      'financial',
      'reporting',
      'forecast',
      'reconciliation',
      'payroll',
      'tax',
      'audit',
      'profit',
      'loss',
      'balance',
    ],
  },
  {
    name: 'HR',
    languageLevel: 'non-technical',
    technicalDetail: 'low',
    suggestedScaffolds: [
      'onboarding-assistant',
      'policy-qa',
      'org-chart-updater',
    ],
    keywords: [
      'hr',
      'human resources',
      'people',
      'hiring',
      'recruiting',
      'onboarding',
      'employee',
      'performance',
      'training',
      'benefits',
      'policy',
      'culture',
      'talent',
      'retention',
      'diversity',
      'inclusion',
    ],
  },
  {
    name: 'Legal',
    languageLevel: 'semi-technical',
    technicalDetail: 'medium',
    suggestedScaffolds: [
      'contract-reviewer',
      'policy-checker',
      'compliance-tracker',
    ],
    keywords: [
      'legal',
      'contract',
      'compliance',
      'regulatory',
      'policy',
      'risk',
      'counsel',
      'agreement',
      'terms',
      'privacy',
      'gdpr',
      'litigation',
      'intellectual property',
      'ip',
      'patent',
      'trademark',
      'review',
    ],
  },
  {
    name: 'Executive',
    languageLevel: 'non-technical',
    technicalDetail: 'low',
    suggestedScaffolds: ['executive-briefing', 'kpi-dashboard', 'board-report'],
    keywords: [
      'executive',
      'leadership',
      'strategy',
      'vision',
      'board',
      'okr',
      'kpi',
      'roadmap',
      'decision',
      'stakeholder',
      'investor',
      'quarterly',
      'priority',
      'initiative',
      'alignment',
      'org',
      'director',
      'vp',
      'cto',
      'ceo',
    ],
  },
];

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

/**
 * Infer the best-matching persona from a description string.
 *
 * Tokenizes the description and counts keyword matches per archetype.
 * Returns the archetype with the most matches. Ties are broken by order
 * in ARCHETYPES (first wins). Returns null for zero matches.
 */
export function inferPersona(description: string): Persona | null {
  if (!description || description.trim().length === 0) return null;

  const lower = description.toLowerCase();

  let bestPersona: Persona | null = null;
  let bestCount = 0;

  for (const persona of ARCHETYPES) {
    let count = 0;
    for (const keyword of persona.keywords) {
      if (lower.includes(keyword.toLowerCase())) {
        count++;
      }
    }
    if (count > bestCount) {
      bestCount = count;
      bestPersona = persona;
    }
    // Ties: first in ARCHETYPES order wins (no update if count === bestCount)
  }

  return bestPersona;
}

// ---------------------------------------------------------------------------
// Memory formatting
// ---------------------------------------------------------------------------

/**
 * Format a persona for inclusion in MEMORY.md.
 *
 * The resulting block is loaded into the agent system prompt and influences
 * language level, technical detail, and suggested scaffolds.
 */
export function formatPersonaForMemory(persona: Persona): string {
  return [
    `## Team Persona: ${persona.name}`,
    '',
    `Language level: ${persona.languageLevel}`,
    `Technical detail: ${persona.technicalDetail}`,
    `Suggested scaffolds: ${persona.suggestedScaffolds.join(', ')}`,
    '',
    '_Inferred from enclave description. The owner can override: "treat us like a technical team"._',
  ].join('\n');
}
