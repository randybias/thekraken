/**
 * Context injector — moved to src/agent/context-injector.ts (Phase 1).
 *
 * Architect decision D14: context injection is a pure function called inline
 * before agent.prompt(), not a pi extension. The pi extension system requires
 * AgentSession wiring from pi-coding-agent, which we do not use.
 *
 * This file is retained as a placeholder for future Phase 2/3 tool-scoping
 * and jargon-filter extensions that use Agent.beforeToolCall/afterToolCall.
 */

export type ContextInjectorMoved = 'see src/agent/context-injector.ts';
