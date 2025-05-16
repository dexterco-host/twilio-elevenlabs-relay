require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fetch = require("node-fetch");

const app = express();
const server = http.createServer(app);

const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ENABLE_TRANSCRIPT = process.env.TRANSCRIPT_LOGGING === "true";

// Use known-good default narrator voice from ElevenLabs
const VOICE_ID = "EXAVITQu4vr4xnSDxMaL";

const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws);
    });
  } else {
    socket.destroy();
  }
});

app.post("/twilio", (_req, res) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="wss://twilio-elevenlabs-relay.onrender.com/ws" />
  </Start>
  <Say voice="Polly.Joanna">This is a fallback test voice. Please hold.</Say>
  <Pause length="10"/>
</Response>`;
  res.type("text/xml").send(xml);
});

app.post("/init", express.json(), (_req, res) => {
  res.json({
    type: "conversation_initiation_client_data",
    start_conversation: true,
    conversation_config_override: {
      agent: {
        prompt: {
          prompt: "You are a test voice from ElevenLabs."
        },
        first_message: "This is a fallback voice test. Please confirm if you can hear this.",
        language: "en"
      },
      tts: { voice_id: VOICE_ID }
    },
    dynamic_variables: {
      caller_name: "TestUser",
      last_interaction: "testing fallback voice"
    }
  });
});

app.get("/", (_req, res) => res.send("🔊 Fallback voice server running."));

wss.on("connection", async (twilioSocket) => {
  let audioQueue = [];
  let streamSidReady = false;

  const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${AGENT_ID}`, {
    headers: { "xi-api-key": ELEVENLABS_API_KEY }
  });

  if (!r.ok) {
    console.error("❌ ElevenLabs auth error:", await r.text());
    twilioSocket.close(); return;
  }

  const { signed_url } = await r.json();
  const elevenSocket = new WebSocket(signed_url);

  elevenSocket.on("open", () => {
    console.log("🧠 ElevenLabs WebSocket connected");
    elevenSocket.send(JSON.stringify({
      agent_id: AGENT_ID,
      enable_transcription: ENABLE_TRANSCRIPT,
      session_id: `twilio-${Date.now()}`
    }));
  });

  elevenSocket.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "conversation_initiation_metadata_event") {
        console.log("🧬 Metadata:", msg);
      }

      if (msg.type === "audio" && msg.audio_event?.audio_base_64) {
        const base64 = msg.audio_event.audio_base_64;
        if (!streamSidReady || !twilioSocket.streamSid) {
          console.warn("⚠️ streamSid not ready — buffering audio");
          audioQueue.push(base64);
          return;
        }
        console.log("📤 Sending audio to Twilio");
        twilioSocket.send(JSON.stringify({
          event: "media",
          streamSid: twilioSocket.streamSid,
          media: { payload: base64 }
        }));
      }
    } catch (err) {
      console.error("⚠️ Error handling ElevenLabs response:", err);
    }
  });

  twilioSocket.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.event === "start") {
        const sid = msg.streamSid || msg.start?.streamSid;
        if (sid) {
          twilioSocket.streamSid = sid;
          streamSidReady = true;
          console.log("🎙️ Twilio stream started:", sid);

          while (audioQueue.length) {
            const base64 = audioQueue.shift();
            twilioSocket.send(JSON.stringify({
              event: "media",
              streamSid: sid,
              media: { payload: base64 }
            }));
          }

          // Single fallback message
          const fallbackMsg = "This is a fallback test voice. Please confirm you can hear this.";
          elevenSocket.send(JSON.stringify({
            type: "agent_response_event",
            audio_behavior: "immediate",
            text: fallbackMsg
          }));
        }
      }

      if (msg.event === "media" && msg.media?.payload && elevenSocket.readyState === WebSocket.OPEN) {
        elevenSocket.send(JSON.stringify({
          type: "user_audio",
          audio: msg.media.payload
        }));
      }
    } catch (err) {
      console.error("⚠️ Error handling Twilio message:", err);
    }
  });

  const cleanup = () => {
    if (elevenSocket.readyState === WebSocket.OPEN) elevenSocket.close();
    if (twilioSocket.readyState === WebSocket.OPEN) twilioSocket.close();
  };

  twilioSocket.on("close", cleanup);
  elevenSocket.on("close", cleanup);
  twilioSocket.on("error", cleanup);
  elevenSocket.on("error", cleanup);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`✅ Listening on port ${PORT}`);
});