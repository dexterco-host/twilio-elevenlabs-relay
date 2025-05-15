require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fetch = require("node-fetch");

const app = express();
const server = http.createServer(app);

// === Environment ============================================================
const AGENT_ID           = process.env.ELEVENLABS_AGENT_ID;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID           = process.env.ELEVENLABS_VOICE_ID;     // Brad’s voice
const ENABLE_TRANSCRIPT  = process.env.TRANSCRIPT_LOGGING === "true";
// ============================================================================

// ---------------------------------------------------------------------------
//  HTTP ROUTES
// ---------------------------------------------------------------------------
app.post("/twilio", (req, res) => {
  // TwiML that opens a media stream, plays a holding prompt, then waits 20 s
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="wss://twilio-elevenlabs-relay.onrender.com/ws" />
  </Start>
  <Say voice="Polly.Joanna">Give me just a second to bring Brad in.</Say>
  <Pause length="20"/>
</Response>`;
  res.type("text/xml").send(xml);
});

app.post("/init", express.json(), (_req, res) => {
  /* This is only called by ElevenLabs if you configured the webhook.
     We keep Brad’s full config here. */
  res.json({
    type: "conversation_initiation_client_data",
    start_conversation: true,
    conversation_config_override: {
      agent: {
        prompt: {
          prompt: "You are AI Brad, the digital twin of Brad Harvey. Be warm, concise and helpful."
        },
        first_message: "Hey — it’s AI Brad. What’s going on?",
        language: "en"
      },
      tts: { voice_id: VOICE_ID }
    },
    dynamic_variables: {
      caller_name: "Friend",
      last_interaction: "recent and friendly"
    }
  });
});

app.get("/", (_req, res) => res.send("🧠 Twilio ↔ ElevenLabs relay running."));

// ---------------------------------------------------------------------------
//  Web‑socket relay
// ---------------------------------------------------------------------------
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url, `http://${req.headers.host}`).pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws));
  } else socket.destroy();
});

wss.on("connection", async (twilioSocket) => {
  console.log("📞 Twilio WebSocket connected");

  // ---------- State -------------
  let audioQueue      = [];   // holds ElevenLabs audio until streamSid ready
  let streamSidReady  = false;

  // ---------- Connect to ElevenLabs ------------
  const r = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${AGENT_ID}`,
    { headers: { "xi-api-key": ELEVENLABS_API_KEY } }
  );
  if (!r.ok) {
    console.error("❌ Could not get signed URL from ElevenLabs:", await r.text());
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

  // ---------- Handle Twilio -> ElevenLabs ----------
  twilioSocket.on("message", data => {
    const msg = JSON.parse(data);
    console.log("📡 Twilio event received:", msg.event);

    if (msg.event === "start") {
      const sid = msg.streamSid || msg.start?.streamSid;
      if (sid) {
        twilioSocket.streamSid = sid;
        streamSidReady = true;
        console.log("🎙️ Twilio stream started:", sid);

        // flush buffered audio
        while (audioQueue.length) {
          const b64 = audioQueue.shift();
          twilioSocket.send(JSON.stringify({
            event: "media",
            streamSid: sid,
            media: { payload: b64 }
          }));
        }

        // Send Brad prompts (0 s, 2.5 s, 4.5 s, 7 s)
        const speak = txt => {
          if (elevenSocket.readyState === WebSocket.OPEN) {
            elevenSocket.send(JSON.stringify({
              type: "agent_response_event",
              audio_behavior: "immediate",
              text: txt
            }));
          }
        };
        speak("Hey — it’s AI Brad. What’s going on?");
        setTimeout(() => speak("Just checking in — can you hear me okay?"), 2500);
        setTimeout(() => speak("Still here — making sure you’re on the line."), 4500);
        setTimeout(() => speak("Final audio test from AI Brad."), 7000);
      }
    }

    if (msg.event === "media" && msg.media?.payload && elevenSocket.readyState === WebSocket.OPEN) {
      elevenSocket.send(JSON.stringify({
        type : "user_audio",
        audio: msg.media.payload
      }));
    }
  });

  // ---------- Handle ElevenLabs -> Twilio ----------
  elevenSocket.on("message", data => {
    const msg = JSON.parse(data);

    if (msg.type === "conversation_initiation_metadata_event") {
      console.log("🧬 Metadata Event:", msg);
    }

    if (msg.type === "audio" && msg.audio_event?.audio_base_64) {
      const b64 = msg.audio_event.audio_base_64;

      if (!streamSidReady) {
        console.warn("⚠️ streamSid not ready — buffering audio chunk");
        audioQueue.push(b64); return;
      }

      twilioSocket.send(JSON.stringify({
        event: "media",
        streamSid: twilioSocket.streamSid,
        media: { payload: b64 }
      }));
    }
  });

  // ---------- Cleanup ----------
  const clean = () => {
    if (elevenSocket.readyState === WebSocket.OPEN) elevenSocket.close();
    if (twilioSocket.readyState   === WebSocket.OPEN) twilioSocket.close();
  };
  twilioSocket.on("close", clean);
  elevenSocket.on("close", clean);
  twilioSocket.on("error", clean);
  elevenSocket.on("error", clean);
});

// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Listening on port ${PORT}`);
});