export default async function handler(req, res) {
  // Zdravotní check (otevři /api/chat v prohlížeči)
  if (req.method === "GET" || req.method === "OPTIONS") {
    const hasKey = !!process.env.OPENAI_API_KEY;
    return res.status(200).json({
      ok: true,
      method: req.method,
      openai_key_present: hasKey,
      hint: hasKey ? "POST /api/chat s {prompt}" : "Přidej OPENAI_API_KEY ve Vercel → Environment Variables a redeploy."
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const key = process.env.OPENAI_API_KEY;
    if (!key) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 600
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
