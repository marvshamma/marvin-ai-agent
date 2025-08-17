export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      method: "GET",
      openai_key_present: !!process.env.OPENAI_API_KEY,
      hint: "POST /api/chat s {prompt}",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const key = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  if (!key) {
    return res
      .status(500)
      .json({ error: "Missing OPENAI_API_KEY in environment" });
  }

  try {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Missing or invalid prompt" });
    }

    const chat = [
      { role: "system", content: "You are Marvin’s personal AI agent." },
      { role: "user", content: prompt },
    ];

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    };

    if (process.env.OPENAI_ORG) {
      headers["OpenAI-Organization"] = process.env.OPENAI_ORG;
    }

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: chat,
        temperature: 0.3,
        max_tokens: 800,
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      return res
        .status(502)
        .json({ error: "OpenAI request failed", detail });
    }

    const data = await r.json();
    const reply = data.choices?.[0]?.message?.content || "(no reply)";

    return res.status(200).json({ reply });
  } catch (err) {
    return res
      .status(500)
      .json({ error: "Server error", detail: err.message });
  }
}
