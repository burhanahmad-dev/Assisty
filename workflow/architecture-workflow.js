export const meta = {
  name: 'assisty-architecture',
  description: 'Research competitors (Chatfuel/ManyChat) + n8n-vs-custom, then design the full production architecture for Assisty (Flutter AI customer-service SaaS)',
  phases: [
    { title: 'Research', detail: 'parallel domain research: competitors, WhatsApp/IG/TikTok APIs, AI/RAG/n8n, multi-tenant security, Flutter+backend+billing' },
    { title: 'Brief', detail: 'condense all findings into one shared research brief' },
    { title: 'Design', detail: '3 competing end-to-end architectures, scored by a 3-judge panel' },
    { title: 'Author', detail: 'parallel writers produce the full architecture doc set' },
    { title: 'Critique', detail: 'completeness critic finds gaps, contradictions, missing pieces' },
  ],
}

const REQ = (args && args.requirements) ? args.requirements : ''
const REF = (args && args.reference) ? args.reference : ''

// ---------------- schemas ----------------
const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    domain: { type: 'string' },
    keyFindings: { type: 'array', items: { type: 'string' } },
    recommendations: { type: 'array', items: { type: 'string' } },
    pitfalls: { type: 'array', items: { type: 'string' } },
    concreteFacts: { type: 'array', items: { type: 'string' }, description: 'API names, pricing models, limits, product names — specific and verifiable' },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['domain', 'keyFindings', 'recommendations'],
  additionalProperties: false,
}

const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    philosophy: { type: 'string' },
    components: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string' }, tech: { type: 'string' } }, required: ['name', 'role', 'tech'], additionalProperties: false } },
    dataFlow: { type: 'string', description: 'end-to-end: inbound msg to AI reply to outbound, including RAG and tenant isolation' },
    aiOrchestration: { type: 'string', description: 'how AI/RAG/memory works and the explicit n8n-vs-custom verdict for THIS design' },
    securityModel: { type: 'string' },
    billingModel: { type: 'string' },
    pros: { type: 'array', items: { type: 'string' } },
    cons: { type: 'array', items: { type: 'string' } },
    monthlyCostEstimate: { type: 'string' },
    mvpTimeWeeks: { type: 'number' },
  },
  required: ['name', 'philosophy', 'components', 'dataFlow', 'pros', 'cons'],
  additionalProperties: false,
}

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    scores: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string' },
      fit: { type: 'number' }, security: { type: 'number' }, scalability: { type: 'number' },
      cost: { type: 'number' }, devSpeed: { type: 'number' }, maintainability: { type: 'number' },
      total: { type: 'number' }, rationale: { type: 'string' },
    }, required: ['name', 'total'], additionalProperties: false } },
    winner: { type: 'string' },
    bestIdeasToGraft: { type: 'array', items: { type: 'string' } },
  },
  required: ['scores', 'winner'],
  additionalProperties: false,
}

const DOC_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    filename: { type: 'string' },
    markdown: { type: 'string' },
  },
  required: ['title', 'filename', 'markdown'],
  additionalProperties: false,
}

const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    gaps: { type: 'array', items: { type: 'string' } },
    contradictions: { type: 'array', items: { type: 'string' } },
    openProductDecisions: { type: 'array', items: { type: 'string' } },
    topRisks: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string' },
  },
  required: ['gaps', 'verdict'],
  additionalProperties: false,
}

const WEB = 'Use WebSearch and WebFetch (load their schemas via ToolSearch first if they are not already available) to gather CURRENT, real, specific information. Prefer primary/official docs. Cite source URLs. If a fact cannot be verified, mark it clearly as an assumption.'

// ---------------- Phase 1: Research ----------------
phase('Research')
const DOMAINS = [
  {
    key: 'competitors',
    prompt: `You are a competitive-intelligence analyst. Research the AI customer-service / chatbot SaaS space for a product called "Assisty". ${WEB}
PRIMARY TARGET: Chatfuel — fetch its Play Store page (${REF}) and research its product. The user explicitly asks: does Chatfuel (and peers) use n8n, or some other automation/orchestration architecture? Investigate what is publicly knowable about their stack and automation model.
Also analyze: ManyChat, Intercom Fin, Tidio/Lyro, Botpress, Voiceflow, Wati, Respond.io, Gallabox.
For each relevant competitor capture: channels supported (WhatsApp/IG/TikTok/web/Messenger), AI model approach, automation/flow-builder model (visual builder vs LLM-native vs n8n-style), pricing model, and any architecture signals (job posts, engineering blogs, docs).
Requirements context: ${REQ}
Return structured findings. concreteFacts should list specific product/pricing/channel facts. recommendations = what Assisty should copy, avoid, or differentiate on.`,
  },
  {
    key: 'whatsapp',
    prompt: `You are a messaging-platform integration expert. Deep-dive the WhatsApp Business Platform for a multi-tenant SaaS where EACH business connects THEIR OWN WhatsApp number. ${WEB}
Cover precisely: Cloud API vs On-Premise (deprecation status); Meta Embedded Signup flow for onboarding tenants; how access tokens / system-user tokens / phone-number-id / WABA-id work and how a SaaS stores them per tenant; webhooks (inbound message delivery) and how to route a webhook to the right tenant; message templates and the 24-hour customer-service window; conversation-based pricing; rate limits and messaging tiers; whether you need to be a Tech Provider / Solution Partner (BSP) and the trade-offs of BSP (Twilio/360dialog/Meta direct).
Requirements context: ${REQ}
Return structured findings with very concrete API/onboarding/pricing facts and the recommended onboarding + token-storage approach.`,
  },
  {
    key: 'social-channels',
    prompt: `You are a social-platform API expert. Assess feasibility of automating customer-service messaging on: Instagram DM, Facebook Messenger, TikTok, plus a website chat widget and email. ${WEB}
For each: which official API exists (Instagram Messaging API via Meta Graph, Messenger Platform, TikTok messaging/business API reality), what permissions/app-review are required, the 24h window rules, inbound webhook model, and HARD LIMITATIONS (e.g. is TikTok DM automation even officially available to third parties?). Be honest about what is NOT feasible and suggest fallbacks.
For the website widget: recommend an approach (embeddable JS widget + websocket/REST + per-tenant API key).
Requirements context: ${REQ}
Return structured findings; pitfalls must call out channels that are impractical and why.`,
  },
  {
    key: 'ai-orchestration',
    prompt: `You are an applied-AI / LLM systems architect. Design the "brain" for a multi-tenant AI customer-service agent. ${WEB}
Decide and justify: (1) RAG architecture over each tenant business info + FAQs + docs — chunking, embeddings (which provider), vector store options (pgvector vs Pinecone vs Firestore vector vs Qdrant) and per-tenant isolation in the vector store; (2) conversation memory (short-term window + long-term); (3) model routing so a tenant can pick Gemini vs GPT (abstraction layer, e.g. an LLM gateway / LiteLLM; per-tenant API-key vs platform-key billing); (4) tool/function-calling (check order status, create ticket, escalate to human handoff); (5) guardrails / anti-hallucination / "I don't know" behavior / PII handling.
CRITICAL: the user asked whether n8n is the right architecture (they saw n8n memory/RAG features). Give a DECISIVE verdict: when n8n (or Temporal/BullMQ/LangGraph/custom) is appropriate vs an anti-pattern for a per-tenant always-on customer-service brain at SaaS scale. Recommend the concrete orchestration approach for Assisty.
Requirements context: ${REQ}
Return structured findings; recommendations must include the explicit n8n verdict.`,
  },
  {
    key: 'multitenant-security',
    prompt: `You are a SaaS security & multi-tenancy architect. The platform stores each business customers conversations AND their third-party channel access tokens — privacy is paramount. ${WEB}
Cover: pooled vs silo vs bridge multi-tenancy and which fits an early SaaS; tenant data isolation patterns for Firestore security rules AND for Postgres row-level security (compare both, since backend choice is open); encryption of third-party access tokens at rest (envelope encryption with a KMS — GCP KMS / cloud KMS — vs app-level libsodium); secrets management; per-tenant rate limiting and abuse; audit logging; GDPR/data-deletion/data-residency obligations for storing end-customer PII; webhook signature verification.
Requirements context: ${REQ}
Return structured findings; recommendations = a concrete, prioritized security baseline for MVP and what to defer.`,
  },
  {
    key: 'flutter-backend-billing',
    prompt: `You are a mobile SaaS architect. Recommend the Flutter app architecture, backend stack, and billing model for Assisty (a Flutter mobile app that is the CONTROL PANEL for businesses; the actual customer messaging happens server-side via channel APIs). ${WEB}
Cover: Flutter app structure (state management — Riverpod vs Bloc, routing, offline, push via FCM); backend options compared — Firebase suite (Auth + Firestore + Cloud Functions, leverages an existing functions/ prototype) VS a custom Node/NestJS service on Cloud Run + Postgres + Redis + a worker/queue — with a clear recommendation and why; realtime updates to the app; SUBSCRIPTION/BILLING — this is B2B SaaS sold to businesses: analyze Google Play Billing policy (does Play require IAP for B2B SaaS, or can you bill externally via Stripe?), Stripe vs RevenueCat, plan/quota/metering design (message limits, AI-token limits per plan).
Requirements context: ${REQ}
Return structured findings; recommendations must give a single recommended stack with rationale.`,
  },
]

const research = (await parallel(DOMAINS.map(d => () =>
  agent(d.prompt, { label: `research:${d.key}`, phase: 'Research', schema: RESEARCH_SCHEMA })
))).filter(Boolean)

// ---------------- Phase 2: Brief ----------------
phase('Brief')
const briefText = await agent(
  `You are the lead architect. Condense the following research into ONE tight, decision-oriented "research brief" (markdown, ~500-900 words) that downstream designers and writers will rely on as ground truth. Keep the most concrete facts (APIs, limits, pricing models, the n8n verdict, the recommended stack leanings, the security baseline) and drop fluff. Note any disagreements between domains.
REQUIREMENTS: ${REQ}
RESEARCH (JSON): ${JSON.stringify(research)}`,
  { label: 'research-brief', phase: 'Brief' }
)

// ---------------- Phase 3: Design ----------------
phase('Design')
const PHILOSOPHIES = [
  { key: 'firebase-native', desc: "Firebase-native serverless: Firebase Auth + Firestore + Cloud Functions + Firestore vector search; maximize managed services and MVP speed; reuse an existing Cloud Functions prototype. Optimize for a solo builder shipping fast." },
  { key: 'custom-cloudnative', desc: "Custom cloud-native: NestJS/Node API on Cloud Run, Postgres + pgvector, Redis, a dedicated worker + durable queue (BullMQ or Temporal) for inbound message processing and AI calls. Optimize for control, scale, and security." },
  { key: 'hybrid-n8n', desc: "Hybrid with workflow-automation: a lean custom core for auth/billing/token-vault, but use n8n (self-hosted, per-tenant or shared with tenant-scoped credentials) for the message-handling and AI/RAG automation flows. Honestly stress-test whether this n8n approach (the founder hunch) holds up or breaks down at SaaS scale." },
]
const designs = (await parallel(PHILOSOPHIES.map(p => () =>
  agent(
    `You are a principal architect. Produce ONE complete end-to-end candidate architecture for "Assisty" following THIS philosophy:
${p.desc}

It must satisfy ALL requirements: ${REQ}

Ground your design in this research brief:
${briefText}

Be concrete: name actual services/libraries, define the inbound to AI to outbound data flow including RAG and per-tenant isolation, the security model (token encryption), and the billing model. Give honest pros/cons, a monthly cost estimate at ~50 active tenants, and an MVP time estimate in weeks. For aiOrchestration, state your explicit n8n-vs-custom verdict for THIS design.`,
    { label: `design:${p.key}`, phase: 'Design', schema: DESIGN_SCHEMA }
  )
))).filter(Boolean)

const judges = (await parallel([1, 2, 3].map(i => () =>
  agent(
    `You are an independent senior architecture reviewer (reviewer #${i}). Score EACH candidate architecture below on a 1-10 scale across: fit (to requirements), security/privacy, scalability, cost, devSpeed (MVP speed for a solo/small team), maintainability. Set total = sum. Pick a single winner and list the best ideas worth grafting from the non-winners into the winner. Be skeptical and concrete; reward security and a sound AI-orchestration decision; penalize hand-waving.
REQUIREMENTS: ${REQ}
RESEARCH BRIEF: ${briefText}
CANDIDATES (JSON): ${JSON.stringify(designs)}`,
    { label: `judge-${i}`, phase: 'Design', schema: JUDGE_SCHEMA }
  )
))).filter(Boolean)

// tally winner by average total score
const tally = {}
designs.forEach(d => { tally[d.name] = [] })
judges.forEach(j => (j.scores || []).forEach(s => { if (tally[s.name]) tally[s.name].push(s.total || 0) }))
let winnerName = designs.length ? designs[0].name : ''
let best = -1
Object.keys(tally).forEach(name => {
  const arr = tally[name]
  const avg = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
  if (avg > best) { best = avg; winnerName = name }
})
const winner = designs.find(d => d.name === winnerName) || designs[0]
const graft = judges.flatMap(j => j.bestIdeasToGraft || [])
log(`Winning architecture: ${winnerName} (avg score ${best.toFixed(1)})`)

const designContext = `WINNING ARCHITECTURE (authoritative — build on this):
${JSON.stringify(winner)}

IDEAS TO GRAFT IN FROM OTHER CANDIDATES:
${graft.map(g => '- ' + g).join('\n')}

ALL CANDIDATES (for context):
${JSON.stringify(designs.map(d => ({ name: d.name, philosophy: d.philosophy })))}`

// ---------------- Phase 4: Author ----------------
phase('Author')
const DOC_SPECS = [
  { key: 'overview', title: 'Assisty — System Architecture Overview', filename: 'ARCHITECTURE.md', focus: 'Executive summary, product vision, the chosen architecture and WHY it won, a high-level component diagram (ASCII), the end-to-end request lifecycle (inbound customer message to tenant routing to RAG retrieval to LLM to guardrails to outbound reply to logging), how all the docs in docs/ fit together, and a glossary. This is the entry-point document and must link to the other docs.' },
  { key: 'channels', title: 'Channel Integrations', filename: 'docs/01-channels.md', focus: 'WhatsApp Business Cloud API: Embedded Signup onboarding, per-tenant token/phone-number-id/WABA storage, webhook routing to the right tenant, 24h window + templates + conversation pricing. Instagram DM + Messenger via Meta Graph. TikTok (be honest about feasibility). Website chat widget (embeddable JS + per-tenant key). Email. A normalized internal channel-adapter abstraction so the AI core is channel-agnostic. Include a per-channel feasibility table.' },
  { key: 'ai', title: 'AI Brain, RAG, Memory & Orchestration', filename: 'docs/02-ai-brain.md', focus: 'The AI core: tenant-scoped RAG (chunking, embeddings, vector store choice + isolation), short/long-term conversation memory, the model-router abstraction so a tenant picks Gemini vs GPT, function/tool calling (order lookup, ticket create, human handoff), guardrails/anti-hallucination/PII. CONTAIN A DEDICATED SECTION giving the decisive verdict on n8n vs custom orchestration (answering the user directly) with the chosen orchestration design.' },
  { key: 'security', title: 'Multi-Tenancy, Security & Privacy', filename: 'docs/03-security.md', focus: 'Tenant isolation model (pooled/silo decision), encryption of third-party access tokens at rest (KMS envelope encryption), data-store security rules / row-level security, secrets management, webhook signature verification, per-tenant rate limiting, audit logging, GDPR (end-customer PII, deletion, residency). Provide an MVP security baseline checklist vs deferred items.' },
  { key: 'data', title: 'Data Model & Backend Services', filename: 'docs/04-data-model.md', focus: 'Concrete data model (entities: Tenant/Business, User, ChannelConnection with encrypted creds, Agent/Bot config, BusinessInfo/KnowledgeDoc, Conversation, Message, Subscription, UsageMeter, AuditLog) with fields and relationships; the backend service decomposition (API, webhook ingest, AI worker, billing) and the APIs between them. Include schema in a clear tabular/code form for the chosen datastore.' },
  { key: 'onboarding-billing', title: 'Auth, Onboarding Flow & Subscriptions', filename: 'docs/05-onboarding-billing.md', focus: 'Auth (signup/login, providers, session). The full onboarding journey: subscribe to connect channel(s) to tap Activate customer-service agent to the BUSINESS-INFO FORM (exact fields: products/services, FAQs, policies, hours, tone) to ingestion into RAG to agent goes live. Billing: B2B plan/quota design (message + AI-token metering), Stripe vs RevenueCat vs Google Play Billing decision incl. Play Store IAP policy for B2B SaaS, plan tiers and what gates the Gemini-vs-GPT choice.' },
  { key: 'roadmap', title: 'Tech Stack, Repo Structure & Phased Roadmap', filename: 'docs/06-roadmap.md', focus: 'The final consolidated tech stack (Flutter app + backend + datastores + AI + infra/hosting + CI/CD). A concrete monorepo/repo folder structure for the D:/Assisty project. A phased roadmap: Phase 0 (skeleton+auth) to Phase 1 (one channel: WhatsApp end-to-end) to Phase 2 (AI brain + RAG + business-info form) to Phase 3 (billing/subscriptions) to Phase 4 (more channels) to Phase 5 (analytics, human handoff, scale). Rough cost model at MVP and at 50/500 tenants.' },
]
const docs = (await parallel(DOC_SPECS.map(s => () =>
  agent(
    `You are a senior technical writer + architect. Write the document "${s.title}" for the Assisty project as polished, production-grade Markdown.
FOCUS / REQUIRED CONTENT: ${s.focus}
Write for a solo/small-team builder: concrete, opinionated, actionable — name specific libraries, services, fields, and decisions; include ASCII diagrams and tables where helpful; avoid vague filler. Stay consistent with the winning architecture; do not contradict it.
REQUIREMENTS: ${REQ}
RESEARCH BRIEF:
${briefText}

ARCHITECTURE DECISION CONTEXT:
${designContext}

Return the document. filename MUST be exactly "${s.filename}" and title "${s.title}".`,
    { label: `author:${s.key}`, phase: 'Author', schema: DOC_SCHEMA }
  )
))).filter(Boolean)

// ---------------- Phase 5: Critique ----------------
phase('Critique')
const critiqueInput = docs.map(d => ({ title: d.title, excerpt: (d.markdown || '').slice(0, 4500) }))
let critique = null
try {
  critique = await agent(
    `You are a ruthless principal-engineer reviewer. Review the assembled Assisty architecture doc set (excerpts below) for GAPS (missing pieces a builder would need), CONTRADICTIONS between docs, OPEN PRODUCT DECISIONS the founder must still make, and the TOP RISKS to the project. Be specific and prioritized. You MUST call the StructuredOutput tool with your findings; keep each list to the 5-8 most important items.
REQUIREMENTS: ${REQ}
DOC EXCERPTS (JSON, title+excerpt):
${JSON.stringify(critiqueInput)}`,
    { label: 'completeness-critic', phase: 'Critique', schema: CRITIC_SCHEMA }
  )
} catch (e) {
  log('Critique agent failed; returning docs without critique: ' + (e && e.message ? e.message : String(e)))
  critique = { gaps: [], contradictions: [], openProductDecisions: [], topRisks: [], verdict: 'Critique step failed to produce structured output; review the docs manually.' }
}

return {
  winner: { name: winner.name, philosophy: winner.philosophy, mvpTimeWeeks: winner.mvpTimeWeeks, monthlyCostEstimate: winner.monthlyCostEstimate },
  scoreTally: Object.keys(tally).map(n => ({ name: n, avg: tally[n].length ? (tally[n].reduce((a, b) => a + b, 0) / tally[n].length) : 0 })),
  graft,
  briefText,
  docs,
  critique,
}
