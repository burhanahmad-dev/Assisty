/**
 * Connectivity check for the AI layer: lists OpenRouter's free models, picks one,
 * and runs a tiny chat completion — proving the key + OpenAI-compatible endpoint
 * work BEFORE we wire them into the live pipeline.
 *
 *   npm run check:ai
 *
 * Reads OPENROUTER_API_KEY (or LITELLM_API_KEY) and LITELLM_BASE_URL from
 * backend/.env. Prints the free model ids so we can set DEFAULT_CHAT_MODEL.
 */
import './load-env';

interface OpenRouterModel {
  id: string;
}

async function main(): Promise<void> {
  const key = process.env.OPENROUTER_API_KEY ?? process.env.LITELLM_API_KEY ?? '';
  if (!key) {
    throw new Error('No OPENROUTER_API_KEY / LITELLM_API_KEY in backend/.env');
  }
  const base = (process.env.LITELLM_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(
    /\/+$/,
    '',
  );

  const modelsRes = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const modelsJson = (await modelsRes.json()) as { data?: OpenRouterModel[] };
  const free = (modelsJson.data ?? []).filter(
    (m) => typeof m.id === 'string' && m.id.endsWith(':free'),
  );

  console.log(`models endpoint status: ${modelsRes.status}`);
  console.log('free models (sample):');
  for (const m of free.slice(0, 15)) {
    console.log('  -', m.id);
  }

  const preferred = free.find((m) =>
    /llama-3\.3|llama-3\.1|gemini-2|qwen|mistral|gemma/i.test(m.id),
  );
  const model = (preferred ?? free[0])?.id;
  if (!model) {
    throw new Error('OpenRouter returned no :free models');
  }
  console.log('\nchosen free model:', model);

  const chatRes = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      max_tokens: 16,
    }),
  });
  const chatJson = (await chatRes.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  console.log('chat status:', chatRes.status);
  console.log(
    'reply:',
    chatJson?.choices?.[0]?.message?.content ??
      JSON.stringify(chatJson).slice(0, 600),
  );
  console.log('\n=> set DEFAULT_CHAT_MODEL in backend/.env to the chosen model above.');
}

main().catch((err) => {
  console.error('check-openrouter failed:', err);
  process.exit(1);
});
