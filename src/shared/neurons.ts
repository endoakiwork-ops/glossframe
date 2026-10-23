/**
 * Workers AI bills in Neurons. These rates come from
 * https://developers.cloudflare.com/workers-ai/platform/pricing/ and turn the
 * token counts this app records into the same unit as the daily free quota.
 */
export const FREE_DAILY_NEURONS = 10_000;

const TEXT_RATES: Record<string, { input: number; output: number }> = {
  // Neurons per 1M tokens.
  "@cf/qwen/qwen3-30b-a3b-fp8": { input: 4_625, output: 30_475 },
  "@cf/zai-org/glm-4.7-flash": { input: 5_500, output: 36_400 },
};

export const SPEECH_MODEL_ID = "@cf/myshell-ai/melotts";
const SPEECH_NEURONS_PER_MINUTE = 18.63;
// MeloTTS is billed per audio minute; English narration runs ~14 chars/s.
const SPEECH_CHARS_PER_SECOND = 14;

/** Unknown models are priced like the most expensive known text model. */
const FALLBACK_RATE = { input: 5_500, output: 36_400 };

export function estimateNeurons(model: string, inputTokens: number, outputTokens: number): number {
  if (model === SPEECH_MODEL_ID) {
    // Speech rows store the synthesized character count in input_tokens.
    const minutes = inputTokens / SPEECH_CHARS_PER_SECOND / 60;
    return minutes * SPEECH_NEURONS_PER_MINUTE;
  }
  const rate = TEXT_RATES[model] ?? FALLBACK_RATE;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

/** Start of the current quota day: the free allocation resets at 00:00 UTC (09:00 JST). */
export function quotaDayStart(now = Date.now()): number {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return start.getTime();
}
