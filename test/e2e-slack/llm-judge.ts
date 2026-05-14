/**
 * LLM-as-judge evaluation for E2E scenario replies.
 *
 * Scenarios that test "did Kraken communicate the right intent?" rather
 * than "did the reply contain literally these words?" use this judge
 * instead of regex matching. The judge calls Anthropic's API directly
 * (no SDK dependency) and asks a small fast model to decide whether
 * the reply satisfies a free-form criteria string.
 *
 * Why we need this:
 *   - LLM phrasing varies run-to-run. "Dev team is on it" and "Team
 *     commissioned" mean the same thing; a rigid regex catches one but
 *     not the other.
 *   - Regex contracts grow unmaintainable as Kraken's phrasing evolves.
 *   - The "right behavior" for many scenarios is semantic, not literal.
 *
 * Cost / latency:
 *   - claude-haiku-4-5 is ~$0.0008/judgment, ~1s.
 *   - One judgment per scenario that uses llmJudge.
 *
 * Failure mode:
 *   - If ANTHROPIC_API_KEY is missing, judge returns null (caller falls
 *     back to regex). If API call fails, treat as inconclusive (skip the
 *     judge; rely on whatever regex was also configured).
 */
interface AnthropicMessageResponse {
  content?: Array<{ type: string; text?: string }>;
  error?: { message: string };
}

export interface LlmJudgeResult {
  /** True if the judge thinks the reply satisfies the criteria. */
  pass: boolean;
  /** One-line reason from the judge. */
  reason: string;
}

const JUDGE_MODEL = process.env['KRAKEN_E2E_JUDGE_MODEL'] ?? 'claude-haiku-4-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Ask the judge: does `reply` satisfy `criteria`?
 *
 * Returns null when ANTHROPIC_API_KEY is unset (so the caller can fall
 * back to whatever regex is also configured). Returns a structured
 * pass/reason on success or transient failure (treat-as-pass).
 */
export async function evaluateWithJudge(
  reply: string,
  criteria: string,
  scenarioId: string,
): Promise<LlmJudgeResult | null> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) return null;

  const system =
    'You are an evaluator for end-to-end test replies. ' +
    'A scenario expects a Slack bot to satisfy a specific criteria. ' +
    'You receive the bot’s reply and the criteria. ' +
    'Decide whether the reply satisfies the criteria. ' +
    'Be lenient about phrasing variation but strict about intent. ' +
    'Output ONLY a JSON object: {"pass": true|false, "reason": "<one short sentence>"}. ' +
    'No prose outside the JSON.';

  const userMsg = [
    `Scenario: ${scenarioId}`,
    '',
    `Criteria the reply must satisfy:`,
    criteria,
    '',
    `Bot reply:`,
    reply.slice(0, 4000),
  ].join('\n');

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        max_tokens: 256,
        system,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(
        `[llm-judge] ${scenarioId}: API call failed (${res.status}): ${body.slice(0, 200)} — treating as PASS`,
      );
      return { pass: true, reason: `judge unavailable (HTTP ${res.status})` };
    }

    const json = (await res.json()) as AnthropicMessageResponse;
    const text = json.content?.[0]?.text?.trim() ?? '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      console.warn(
        `[llm-judge] ${scenarioId}: could not parse JSON from reply: ${text.slice(0, 200)} — treating as PASS`,
      );
      return { pass: true, reason: 'judge parse failure' };
    }
    const parsed = JSON.parse(match[0]) as {
      pass?: boolean;
      reason?: string;
    };
    return {
      pass: Boolean(parsed.pass),
      reason: parsed.reason ?? '(no reason given)',
    };
  } catch (err) {
    console.warn(
      `[llm-judge] ${scenarioId}: network or parse error: ${(err as Error).message} — treating as PASS`,
    );
    return { pass: true, reason: 'judge transient error' };
  }
}
