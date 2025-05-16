require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fetch = require("node-fetch");

const app = express();
const server = http.createServer(app);

const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ENABLE_TRANSCRIPT = process.env.TRANSCRIPT_LOGGING === "true";

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
  <Say voice="Polly.Joanna">Give me just a second to bring Brad in.</Say>
  <Pause length="20"/>
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
          prompt: "You are AI Brad, the digital twin of Brad Harvey. Be warm, concise, and helpful."
        },
        first_message: "Hey — it’s AI Brad. What’s going on?",
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

app.get("/", (_req, res) => res.send("🧠 AI Brad relay is live."));

wss.on("connection", async (twilioSocket) => {
  let audioQueue = [];
  let streamSidReady = false;

  console.log("📞 Twilio WebSocket connected");

  const signedRes = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${AGENT_ID}`, {
    headers: { "xi-api-key": ELEVENLABS_API_KEY }
  });

  if (!signedRes.ok) {
    console.error("❌ Failed to get ElevenLabs signed URL:", await signedRes.text());
    twilioSocket.close(); return;
  }

  const { signed_url } = await signedRes.json();
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
        console.log("🧬 Metadata Event:", msg);
      }

      if (msg.type === "audio" && msg.audio_event?.audio_base_64) {
        const base64 = msg.audio_event.audio_base_64;
        if (!streamSidReady || !twilioSocket.streamSid) {
          console.warn("⚠️ Buffering audio until streamSid is ready");
          audioQueue.push(base64);
          return;
        }

        twilioSocket.send(JSON.stringify({
          event: "media",
          streamSid: twilioSocket.streamSid,
          media: { payload: base64 }
        }));
      }

      if (msg.type === "ping" && msg.ping_event?.event_id) {
        elevenSocket.send(JSON.stringify({
          type: "pong",
          event_id: msg.ping_event.event_id
        }));
      }

      if (msg.type === "interruption" && streamSidReady) {
        twilioSocket.send(JSON.stringify({
          event: "clear",
          streamSid: twilioSocket.streamSid
        }));
      }

    } catch (err) {
      console.error("⚠️ ElevenLabs message error:", err);
    }
  });

  twilioSocket.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      console.log("📡 Twilio event:", msg.event);

      if (msg.event === "start") {
        const sid = msg.streamSid || msg.start?.streamSid;
        if (sid) {
          twilioSocket.streamSid = sid;
          streamSidReady = true;
          console.log("🎙️ Twilio stream started:", sid);

          while (audioQueue.length) {
            const b64 = audioQueue.shift();
            twilioSocket.send(JSON.stringify({
              event: "media",
              streamSid: sid,
              media: { payload: b64 }
            }));
          }

          const speak = (text) => {
            if (elevenSocket.readyState === WebSocket.OPEN) {
              elevenSocket.send(JSON.stringify({
                type: "agent_response_event",
                audio_behavior: "immediate",
                text
              }));
            }
          };

          speak("Hey — it’s AI Brad. What’s going on?");
          setTimeout(() => speak("Just checking in — can you hear me okay?"), 2500);
          setTimeout(() => speak("Still here — making sure you’re on the line."), 4500);
          setTimeout(() => speak("Final audio test from AI Brad."), 7000);
        }
      }

      if (msg.event === "media" && msg.media?.payload && elevenSocket.readyState === WebSocket.OPEN) {
        elevenSocket.send(JSON.stringify({
          type: "user_audio",
          audio: msg.media.payload
        }));
      }

    } catch (err) {
      console.error("⚠️ Twilio message error:", err);
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