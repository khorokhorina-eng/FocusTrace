# OpenAI TTS Proxy (for the extension)

This lightweight server keeps your OpenAI API key off the client and returns
audio for each text chunk.

## 1) Install

```bash
cd ai-server
npm install
```

## 2) Configure

Create a `.env` file:

```
OPENAI_API_KEY=your_openai_api_key
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TTS_VOICE=alloy
PORT=8787
```

The server loads `.env` automatically.

## 3) Run

```bash
npm start
```

The server will listen on:

```
http://localhost:8787/tts
```

## 4) Update the extension

Edit `config.js` in the extension root:

```js
window.PDF_TTS_CONFIG = {
  aiEndpoint: "http://localhost:8787/tts",
  aiEnabledByDefault: false,
  aiDefaultVoice: "alloy",
};
```

Then reload the extension in `chrome://extensions`.

## Notes

- The server expects JSON: `{ text, speed, voice }`
- The response is `audio/mpeg`
- Add CORS if you deploy behind a reverse proxy
