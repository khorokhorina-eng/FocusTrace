const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 8787;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "alloy";

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/tts", async (req, res) => {
  if (!OPENAI_API_KEY) {
    res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    return;
  }

  const { text, speed, voice } = req.body || {};
  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "Missing text" });
    return;
  }
  if (text.length > 4000) {
    res.status(400).json({ error: "Text too long" });
    return;
  }

  const payload = {
    model: OPENAI_TTS_MODEL,
    input: text,
    voice: voice || OPENAI_TTS_VOICE,
    response_format: "mp3",
  };

  if (typeof speed === "number" && Number.isFinite(speed)) {
    payload.speed = Math.min(Math.max(speed, 0.5), 2.0);
  }

  try {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      res.status(response.status).send(errorText);
      return;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: "TTS request failed" });
  }
});

app.listen(PORT, () => {
  console.log(`AI TTS server listening on http://localhost:${PORT}`);
});
