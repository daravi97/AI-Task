// The store assistant ("Merch Bot"). Uses Claude when ANTHROPIC_API_KEY is set,
// otherwise falls back to keyword matching against the FAQ table so the app works offline.
const Anthropic = require('@anthropic-ai/sdk');
const store = require('./store');
const { formatDate } = require('./config');

const MODEL = process.env.ASSISTANT_MODEL || 'claude-opus-5-5';
const MAX_TOOL_ROUNDS = 5;
const MAX_HISTORY = 12;
const MAX_MESSAGE_CHARS = 2000;

const TOOLS = [
  {
    name: 'get_my_wallet',
    description: "Get the current user's token balance and their most recent token transactions (awards, purchases, refunds).",
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'get_my_orders',
    description: "List the current user's orders with status (pending, processing, ready, collected, cancelled), items, token totals and collection date/time/location.",
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'search_products',
    description: 'Search the merchandise catalog by keyword (name, description or category). Pass an empty string to list everything. Returns price in tokens and stock.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Keyword, e.g. "hoodie" or "Drinkware". Empty string for all products.' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

function systemPrompt(faqs) {
  const faqText = faqs.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n');
  return `You are Merch Bot, the friendly assistant inside the company's merchandise store.
Staff receive appreciation tokens for good work and spend them in this store on company merchandise.

Answer questions about the store, tokens, orders and products. Use the FAQ below as the source of truth for policy.
Use the tools to look up the user's own balance, orders (including their collection date, time and location), or the live catalog instead of guessing.
Staff receive an order confirmation email with their collection details and a reminder email the day before collection. You can only read data:
you cannot place, change or cancel orders, or award tokens — tell the user where to do that in the app
(Shop → Cart → Checkout; My Orders → Cancel for pending orders; admins award tokens).
If a question is not covered by the FAQ or tools, say you are not sure and suggest contacting the HR / People team.
Keep answers short (a few sentences or a brief list) and friendly. Prices are in tokens, not money.

FAQ:
${faqText}`;
}

function runTool(db, user, name, input) {
  switch (name) {
    case 'get_my_wallet':
      return { balance: store.getBalance(db, user.id), recent_transactions: store.getLedger(db, user.id, 10) };
    case 'get_my_orders':
      return store.listOrders(db, { userId: user.id }).slice(0, 20).map((o) => ({
        id: o.id, status: o.status, total_tokens: o.total, placed_at: o.created_at,
        items: o.items.map((i) => `${i.quantity} × ${i.product_name}`),
        collection: o.collection_date
          ? { date: formatDate(o.collection_date), time: `${o.collection_start}–${o.collection_end}`, location: o.collection_location, notes: o.collection_notes }
          : 'to be confirmed (the user will be emailed when a collection day is scheduled)',
      }));
    case 'search_products':
      return store.searchProducts(db, input?.query ?? '');
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Keep only well-formed text turns from the client, starting with a user turn.
function sanitizeHistory(history) {
  const turns = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }))
    .slice(-MAX_HISTORY);
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

async function askClaude(client, db, user, message, history) {
  const messages = [...sanitizeHistory(history), { role: 'user', content: message }];
  const system = [{ type: 'text', text: systemPrompt(store.listFaqs(db)), cache_control: { type: 'ephemeral' } }];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low' },
      // Server-side refusal fallback: if a safety classifier declines, the API retries on a suitable model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === 'refusal') {
      return "Sorry, I can't help with that one. Please contact the HR / People team.";
    }
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return text || "Sorry, I couldn't come up with an answer. Please try rephrasing.";
    }

    messages.push({ role: 'assistant', content: response.content });
    const results = toolUses.map((tu) => {
      try {
        return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(runTool(db, user, tu.name, tu.input)) };
      } catch (err) {
        return { type: 'tool_result', tool_use_id: tu.id, content: String(err.message), is_error: true };
      }
    });
    messages.push({ role: 'user', content: results });
  }
  return 'Sorry, that took too many steps. Please try a simpler question.';
}

// ---------- Offline fallback ----------

const STOP_WORDS = new Set('a an the i my me is are do does can how what when where who why to of for in on it and or be with you your'.split(' '));

function tokenize(text, { keepStopWords = false } = {}) {
  const words = String(text).toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return keepStopWords ? words : words.filter((w) => !STOP_WORDS.has(w));
}

function keywordAnswer(db, user, message) {
  const words = tokenize(message);
  const allWords = tokenize(message, { keepStopWords: true });
  const has = (...keys) => keys.some((k) => allWords.includes(k));

  if (has('balance', 'wallet') || (has('tokens', 'token') && has('many', 'left', 'much', 'have'))) {
    return `You currently have ${store.getBalance(db, user.id)} tokens. You can see the full history under My Wallet.`;
  }
  const asksOrderStatus = has('status', 'track', 'tracking')
    || (has('orders') && has('my'))
    || (has('order') && has('where', 'latest', 'last', 'recent') && !has('collect', 'pickup', 'pick'));
  if (asksOrderStatus) {
    const orders = store.listOrders(db, { userId: user.id });
    if (orders.length === 0) return "You haven't placed any orders yet. Head to the Shop to pick something!";
    const lines = orders.slice(0, 5).map((o) => `• Order #${o.id}: ${o.status} (${o.total} tokens)`);
    return `Here are your latest orders:\n${lines.join('\n')}`;
  }

  if (has('collect', 'collection', 'pickup', 'pick')) {
    const active = store.listOrders(db, { userId: user.id }).filter((o) => ['pending', 'processing', 'ready'].includes(o.status));
    if (active.length) {
      const lines = active.slice(0, 5).map((o) => (o.collection_date
        ? `• Order #${o.id}: ${formatDate(o.collection_date)}, ${o.collection_start}–${o.collection_end} at ${o.collection_location}`
        : `• Order #${o.id}: collection date to be confirmed — you'll get an email once it's scheduled`));
      return `Here's when and where to collect your orders:\n${lines.join('\n')}\nYou'll also get a reminder email the day before.`;
    }
  }

  let best = null;
  let bestScore = 0;
  for (const faq of store.listFaqs(db)) {
    const vocab = new Set([...tokenize(faq.keywords), ...tokenize(faq.question)]);
    const score = words.filter((w) => vocab.has(w)).length;
    if (score > bestScore) { best = faq; bestScore = score; }
  }
  if (best) return best.answer;

  const products = words.flatMap((w) => store.searchProducts(db, w)).filter((p, i, arr) => arr.findIndex((q) => q.id === p.id) === i);
  if (products.length) {
    return `I found these items:\n${products.slice(0, 5).map((p) => `• ${p.name} — ${p.price} tokens (${p.stock} in stock)`).join('\n')}`;
  }
  return "I'm not sure about that one. Try asking about tokens, orders, collection or cancellations — or contact the HR / People team.";
}

// ---------- Public API ----------

function createAssistant({ apiKey = process.env.ANTHROPIC_API_KEY, client = null } = {}) {
  const claude = client ?? (apiKey ? new Anthropic({ apiKey }) : null);
  return {
    mode: claude ? 'claude' : 'faq',
    async reply(db, user, message, history = []) {
      message = String(message ?? '').trim().slice(0, MAX_MESSAGE_CHARS);
      if (!message) return 'Ask me anything about the store, your tokens or your orders!';
      if (!claude) return keywordAnswer(db, user, message);
      try {
        return await askClaude(claude, db, user, message, history);
      } catch (err) {
        if (err instanceof Anthropic.APIError) {
          console.error(`Assistant API error ${err.status}: ${err.message}`);
        } else {
          console.error('Assistant error:', err);
        }
        // Degrade gracefully rather than leaving the user with nothing.
        return keywordAnswer(db, user, message);
      }
    },
  };
}

module.exports = { createAssistant, keywordAnswer, sanitizeHistory, TOOLS };
