# Enclave Personas Reference

## What is a Persona?

An enclave persona is a behavioral profile loaded from the enclave's
`MEMORY.md` in the git-state repo. It tells the manager how the team prefers
to interact — formality level, depth of explanation, tooling preferences, etc.

Persona content is injected as the `enclaveMemory` layer in the manager's
system prompt (see `buildManagerPrompt()` in `src/agent/system-prompt.ts`).

## Default Behavior (No Persona Loaded)

When `enclaveMemory` is null or not yet loaded, the manager uses the
`ENCLAVE_MEMORY_PLACEHOLDER`:

> "This channel is bound to a Tentacular enclave. Tools you invoke will
> operate within that enclave's Kubernetes namespace by default."

This is intentionally minimal — the manager should function correctly without
a persona, just without team-specific customization.

## Writing Enclave MEMORY.md

The enclave MEMORY.md lives in the git-state repo at:
`enclaves/<enclave-name>/MEMORY.md`

It should describe:
- The team's domain (what they build and run)
- Preferred terminology (e.g. "jobs" instead of "workflows")
- Tooling context (what tentacles are deployed, what they do)
- Any standing context the manager should remember across sessions

Example:
```markdown
# Platform Engineering Enclave

This enclave runs the internal developer platform team's automation.

Key tentacles:
- `onboarding-flow`: provisions new engineer environments
- `cost-report`: weekly AWS cost digest to #finops

Team prefers brief replies. Use tables for status, not prose.
```

## Persona Archetypes (observed patterns)

These are not hardcoded — they emerge from how teams write their MEMORY.md:

| Archetype | Characteristics | Manager adjustment |
|-----------|----------------|-------------------|
| Platform team | Infrastructure-focused, high automation | Use infrastructure terminology, assume kubectl familiarity |
| Product team | Feature-focused, less infra background | Avoid Kubernetes jargon, explain status in product terms |
| Data team | Batch jobs, cron-heavy | Emphasize job schedules, completion status, failure rates |
| Security team | Audit-focused, cautious | Emphasize permissions, access controls, audit trails |

## Persona is NOT Identity

The manager persona is about communication style, not permissions. All
permission enforcement is done by the MCP server based on OIDC identity —
persona has no effect on what tools can be called or by whom.
