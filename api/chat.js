export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

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

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

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
    body = {};
  }

  const key = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  if (!key) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

  let userPrompt = body?.prompt;
  const messages = body?.messages;
  if (!userPrompt && Array.isArray(messages)) {
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    userPrompt = lastUser?.content || "(empty)";
  }
  if (!userPrompt) return res.status(400).json({ error: "Missing prompt or messages" });

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: body?.systemPrompt || "You are a helpful assistant." },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 800
      })
    });

    if (!r.ok) {
      const detail = await r.text();
      return res.status(502).json({ error: "OpenAI request failed", detail });
    }
    const data = await r.json();
    return res.status(200).json({ reply: data?.choices?.[0]?.message?.content || "(empty)" });
  } catch (err) {
    return res.status(500).json({ error: "Server error", detail: String(err?.message || err) });
  }
}
