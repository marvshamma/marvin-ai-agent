// /api/chat.js — RAG + few-shots + policies (Vercel serverless, statický web)
// ---------------------------------------------------------------
// ENV (Vercel → Project → Settings → Environment Variables):
//   OPENAI_API_KEY         = sk-...   (povinné)
//   OPENAI_MODEL           = gpt-4o-mini  (doporučeno; můžeš změnit)
//   OPENAI_EMBED_MODEL     = text-embedding-3-small  (nebo -large)
//   SYSTEM_PROMPT          = (tvůj System prompt celý z bodu 1)
//   FEW_SHOTS              = (FS1..FS5 — oddělené třeba \n\n---\n\n)
//   POLICIES               = (Guardrails z bodu 4)
//   OPENAI_ORG             = org_...  (volitelné, když máš více orgs)
//
// KNOWLEDGE:
//   V repu vytvoř složku /knowledge a do ní soubory K1..K9 jako .md.
//   (Např. knowledge/K1-executive-bio.md, knowledge/K2-value.md, ...)

import fs from "fs/promises";
import path from "path";

// ----------------- Utils -----------------
async function readKnowledgeDir() {
  const base = path.join(process.cwd(), "knowledge");
  try {
    const files = await fs.readdir(base);
    const mds = files.filter((f) => f.toLowerCase().endsWith(".md"));
    const out = [];
    for (const f of mds) {
      try {
        const text = await fs.readFile(path.join(base, f), "utf8");
        out.push({ name: f, text });
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

// jednoduché sekání na kousky ~800 znaků
function chunkDocs(docs, size = 800) {
  const chunks = [];
  for (const d of docs) {
    for (let i = 0; i < d.text.length; i += size) {
      const slice = d.text.slice(i, i + size);
      if (slice.trim()) chunks.push({ name: d.name, text: slice });
    }
  }
  return chunks;
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i], vb = b[i];
    dot += va * vb;
    na += va * va;
    nb += vb * vb;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

// Global cache (držák pro cold starty)
let EMBED_CACHE = {
  model: null,
  chunks: null,      // [{name,text,vec}]
  dim: null,
};

// ----------------- OpenAI helpers -----------------
async function embedTexts({ apiKey, org, model, inputs }) {
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };
  if (org) headers["OpenAI-Organization"] = org;

  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers,
    body: JSON.stringify({ model, input: inputs }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Embeddings failed: ${t}`);
  }
  const j = await r.json();
  return j.data.map((d) => d.embedding);
}

async function callChat({ apiKey, org, model, messages }) {
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };
  if (org) headers["OpenAI-Organization"] = org;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.3,
      max_tokens: 900,
    }),
  });

  if (!r.ok) {
    const detail = await r.text();
    return { ok: false, detail };
  }
  const data = await r.json();
  const reply = data?.choices?.[0]?.message?.content || "(empty)";
  return { ok: true, reply };
}

// ----------------- RAG retrieve -----------------
async function retrieveTopChunks({ apiKey, org, embedModel, userQuery, k = 3 }) {
  // načti a nainicializuj knowledge embeddings pokud nejsou
  if (!EMBED_CACHE.chunks || EMBED_CACHE.model !== embedModel) {
    const docs = await readKnowledgeDir();
    const pieces = chunkDocs(docs, 800);
    const vecs = await embedTexts({ apiKey, org, model: embedModel, inputs: pieces.map(p => p.text) });
    EMBED_CACHE = {
      model: embedModel,
      chunks: pieces.map((p, i) => ({ ...p, vec: vecs[i] })),
      dim: vecs[0]?.length || null,
    };
  }
  // embed query
  const [qvec] = await embedTexts({ apiKey, org, model: embedModel, inputs: [userQuery || ""] });
  // score & sort
  const scored = EMBED_CACHE.chunks
    .map(c => ({ ...c, score: cosineSim(qvec, c.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return scored;
}

// ----------------- Main handler -----------------
export default async function handler(req, res) {
  // CORS + health (usnadní testy)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      method: "GET",
      openai_key_present: !!process.env.OPENAI_API_KEY,
      knowledge_present: "(zkontroluj /knowledge v repu)",
      hint: "POST /api/chat s {prompt} nebo {systemPrompt+messages}",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ---- Safe JSON body parse ----
  let body = {};
  try {
    if (req.body && typeof req.body === "object") {
      body = req.body;
    } else {
      const chunks = [];
      for await (const ch of req) chunks.push(ch);
      const raw = Buffer.concat(chunks).toString("utf8");
      body = raw ? JSON.parse(raw) : {};
    }
  } catch {
    body = {};
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const org    = process.env.OPENAI_ORG || null;
  const chatModel  = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const embedModel = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
  const SYSTEM    = process.env.SYSTEM_PROMPT || "You are a helpful assistant.";
  const FEWS      = process.env.FEW_SHOTS || "";
  const POLICIES  = process.env.POLICIES || "";

  if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

  // 1) Získej uživatelský dotaz
  let userPrompt = body?.prompt;
  const messages = body?.messages;
  if (!userPrompt && Array.isArray(messages)) {
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    userPrompt = lastUser?.content || "";
  }
  if (!userPrompt) return res.status(400).json({ error: "Missing prompt or messages" });

  // 2) Retrieve z knowledge (RAG)
  let top = [];
  try {
    top = await retrieveTopChunks({ apiKey, org, embedModel, userQuery: userPrompt, k: 3 });
  } catch (e) {
    // když embeddings selžou (quota, model), běž bez RAG
    top = [];
  }

  // 3) Poskládej system prompt = SYSTEM + POLICIES + CONTEXT
  let contextBlock = "";
  if (top.length) {
    contextBlock =
      "\n\n[CONTEXT — internal, do not expose filenames]\n" +
      top.map(t => `# ${t.name}\n${t.text}`).join("\n---\n") +
      "\n[END CONTEXT]\n";
  }

  const finalSystem = `${SYSTEM}\n\n[POLICIES]\n${POLICIES}\n${contextBlock}`;

  // 4) Few-shots → vložíme jako extra zprávy (pokud jsou)
  const fewShotMessages = [];
  if (FEWS.trim()) {
    // rozsekáme oddělovačem --- (nebo necháme jako jeden blok)
    const parts = FEWS.split(/\n-{3,}\n/);
    for (const p of parts) {
      const txt = p.trim();
      if (!txt) continue;
      // Volíme pattern: user zadává typ otázky, assistant ukáže vzor odpovědi
      // Pokud máš FS1/FS2… už ve formátu „Q/A“, klidně to nech jako jednorázový system;
      // tady zachováme jednoduché „assistant“ příklady:
      fewShotMessages.push({ role: "assistant", content: txt });
    }
  }

  // 5) Sestav finální konverzaci
  const chat = [
    { role: "system", content: finalSystem },
    ...fewShotMessages,
    { role: "user", content: userPrompt },
  ];

  // 6) Zavolej model
  try {
    const out = await callChat({ apiKey, org, model: chatModel, messages: chat });
    if (!out.ok) {
      return res.status(502).json({ error: "OpenAI request failed", detail: out.detail });
    }
    // Doplň CTA (jak žádáš v System promptu), pokud model sám nepřidal:
    let reply = out.reply || "";
    const hasCTA = /slide|deck|one\-pager|email|next steps|další kroky/i.test(reply);
    if (!hasCTA) {
      reply += `\n\n— Next steps: Would you like a 3-slide deck or a 120-word intro email tailored to G42/Analog AI?`;
    }
    return res.status(200).json({ reply });
  } catch (err) {
    return res.status(500).json({ error: "Server error", detail: String(err?.message || err) });
  }
}
