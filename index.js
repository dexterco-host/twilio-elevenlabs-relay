require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fetch = require("node-fetch");
const fs = require("fs");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ENABLE_TRANSCRIPTION = process.env.TRANSCRIPT_LOGGING === "true";

// WebSocket Server: Upgrade handler for Twilio stream
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);
  console.log("🔄 WebSocket upgrade requested at", pathname);

  if (pathname === "/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

app.post("/twilio", (req, res) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <Response>
    <Start>
      <Stream url="wss://twilio-elevenlabs-relay.onrender.com/ws" />
    </Start>
    <Say voice="Polly.Joanna">Give me just a second to bring Brad in.</Say>
    <Pause length="15" />
  </Response>`;
  

  console.log("🧾 TwiML returned to Twilio:\n", xml);
  res.type("text/xml");
  res.send(xml);
});

app.post("/init", express.json(), (req, res) => {
  const { caller_id } = req.body;
  
  console.log("📡 ElevenLabs requested call init for:", caller_id);
  console.log("🧬 Using voice ID:", process.env.ELEVENLABS_VOICE_ID);

  const responseData = {
    type: "conversation_initiation_client_data",
    start_conversation: true, // 👈 Force it to speak!
    conversation_config_override: {
      agent: {
        prompt: {
          prompt: "You are AI Brad, the digital twin of Brad Harvey..."
        },
        first_message: "Hey — it’s AI Brad. What’s going on?",
        language: "en"
      },
      tts: {
        voice_id: process.env.ELEVENLABS_VOICE_ID
      }
    },
    dynamic_variables: {
      caller_name: "Brad",
      last_interaction: "friendly and recent"
    }
  };
  

wss.on("connection", async (twilioSocket) => {
  console.log("📞 Twilio WebSocket connected");

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${AGENT_ID}`,
      {
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY
        }
      }
    );

    if (!res.ok) {
      const errorText = await res.clone().text();
      console.error("❌ Failed to get signed ElevenLabs URL:", errorText);
      twilioSocket.close();
      return;
    }

    const { signed_url } = await res.json();

    const elevenSocket = new WebSocket(signed_url);

    elevenSocket.on("open", () => {
      console.log("🧠 ElevenLabs WebSocket connected");
      elevenSocket.send(
        JSON.stringify({
          agent_id: AGENT_ID,
          enable_transcription: ENABLE_TRANSCRIPTION,
          session_id: `twilio-${Date.now()}`
        })
      );
    });

    twilioSocket.on("message", (data) => {
      try {
        const msg = JSON.parse(data);

        if (msg.event === "start") {
          twilioSocket.streamSid = msg.streamSid;
          console.log(`🎙️ Twilio stream started: ${twilioSocket.streamSid}`);
        }

        if (msg.event === "media" && msg.media?.payload && elevenSocket.readyState === WebSocket.OPEN) {
          const base64 = msg.media.payload;
          const buffer = Buffer.from(base64, 'base64');
          const sample = buffer.slice(0, 16).toString('hex');

          console.log("🎤 Twilio user audio received. First 16 bytes:", sample);
          console.log("→ Forwarding audio to ElevenLabs");
          
          fs.appendFileSync('twilio-input.ulaw', buffer);

          elevenSocket.send(
            JSON.stringify({
              type: "user_audio",
              audio: base64
            })
          );
        }
      } catch (err) {
        console.error("⚠️ Error parsing Twilio message:", err);
      }
    });

    elevenSocket.on("message", (data) => {
      try {
        console.log("📥 Raw ElevenLabs message:", data.toString().slice(0, 500));
        const msg = JSON.parse(data);

        if (
          msg.type === "audio" &&
          msg.audio_event?.audio_base_64 &&
          twilioSocket.readyState === WebSocket.OPEN
        ) {
          const base64 = msg.audio_event.audio_base_64;
          const buffer = Buffer.from(base64, 'base64');
          const sample = buffer.slice(0, 16).toString('hex');

          console.log("🎧 ElevenLabs audio payload (first 16 bytes):", sample);
          fs.appendFileSync('audio-dump.ulaw', buffer);

          const wrapped = {
            event: "media",
            streamSid: twilioSocket.streamSid || "unknown",
            media: { payload: base64 }
          };

          twilioSocket.send(JSON.stringify(wrapped));
        }

        console.log("🗣️ ElevenLabs AI:", msg);
      } catch (err) {
        console.error("⚠️ Error processing ElevenLabs message:", err);
      }
    });

    const cleanup = () => {
      if (elevenSocket.readyState === WebSocket.OPEN) elevenSocket.close();
      if (twilioSocket.readyState === WebSocket.OPEN) twilioSocket.close();
    };

    twilioSocket.on("close", () => {
      console.log("❌ Twilio socket closed");
      cleanup();
    });

    elevenSocket.on("close", () => {
      console.log("🔌 ElevenLabs socket closed");
      cleanup();
    });

    twilioSocket.on("error", (err) => {
      console.error("❗ Twilio socket error:", err);
      cleanup();
    });

    elevenSocket.on("error", (err) => {
      console.error("❗ ElevenLabs socket error:", err);
      cleanup();
    });

  } catch (err) {
    console.error("❌ Unexpected error in relay:", err);
    twilioSocket.close();
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("🧠 Twilio → ElevenLabs relay server is live.");
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Listening on port ${PORT}`);
});
