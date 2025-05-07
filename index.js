const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const AGENT_ID = process.env.AGENT_ID || "aiBrad";
const ENABLE_TRANSCRIPTION = process.env.TRANSCRIPT_LOGGING === "true";

wss.on("connection", async (twilioSocket) => {
  console.log("📞 Twilio WebSocket connected");

  try {
    // Step 1: Get a signed URL from ElevenLabs
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${AGENT_ID}`,
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
        },
      }
    );

    const { signed_url } = await res.json();
    if (!signed_url) {
      console.error("❌ Failed to get signed ElevenLabs URL");
      twilioSocket.close();
      return;
    }

    // Step 2: Connect to ElevenLabs
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

    // Step 3: Forward Twilio audio → ElevenLabs
    twilioSocket.on("message", (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.event === "media") {
          const audio = msg.media.payload;
          if (elevenSocket.readyState === WebSocket.OPEN) {
            elevenSocket.send(JSON.stringify({ audio }));
          }
        }
      } catch (err) {
        console.error("⚠️ Error parsing Twilio message:", err);
      }
    });

    // Step 4: Log ElevenLabs messages
    elevenSocket.on("message", (data) => {
      try {
        const parsed = JSON.parse(data);
        console.log("🗣️ ElevenLabs AI:", parsed);
      } catch (err) {
        console.error("⚠️ Error parsing ElevenLabs message:", err);
      }
    });

    // Step 5: Clean up on disconnect or error
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
    console.error("❌ Error setting up WebSocket relay:", err);
    twilioSocket.close();
  }
});

app.get("/", (req, res) => {
  res.send("🧠 Twilio → ElevenLabs WebSocket relay is running.");
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`✅ Listening on port ${PORT}`);
});
