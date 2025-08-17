// /api/chat.js – Vercel Serverless (odolná verze)
export default async function handler(req, res) {
  // CORS/health
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method === "GET") {
    const hasKey = !!process.env.OPENAI_API_KEY;
    return res.status(200).json({
      ok: true,
      method: "GET",
      openai_key_present: hasKey,
      hint: hasKey ? "POST /api/chat s {prompt} nebo {systemPrompt+messages}" :
        "Přidej OPENAI_API_KEY ve Vercel → Environment Variables a redeploy."
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // --- Bezpečné načtení těla (funguje i když Vercel nepředzpracuje JSON) ---
  let body = {};
  try {
    if (req.body && typeof req.body === "object") {
      body = req.body;
    } else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      body = raw ? JSON.parse(raw) : {};
    }
  } catch {
    // necháme body prázdné; ošetříme níže
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

  // Podpora dvou tvarů požadavku:
  // 1) { prompt: "text" }  – jednoduchý HTML chat
  // 2) { systemPrompt, messages: [...], mode, user } – pokročilý chat (React verze)
  let userPrompt = body?.prompt;
  let messages = body?.messages;

  if (!userPrompt && Array.isArray(messages)) {
    // poskládejme prompt z poslední user zprávy
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    userPrompt = lastUser?.content || "(empty)";
  }

  if (!userPrompt) {
    return res.status(400).json({ error: "Missing prompt or messages" });
  }

  // Sestavení messages pro OpenAI
  const systemPrompt = body?.systemPrompt || "You are a helpful assistant.";
  const chat = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        messages: chat,
        temperature: 0.3,
        max_tokens: 800
      })
    });

    if (!r.ok) {
      const detail = await r.text();
      return res.status(502).json({ error: "OpenAI request failed", detail });
    }

    const data = await r.json();
    const reply = data?.choices?.[0]?.message?.content || "(empty)";
    return res.status(200).json({ reply });
  } catch (err) {
    return res.status(500).json({ error: "Server error", detail: String(err?.message || err) });
  }
}
