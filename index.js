const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const agentId = "aiBrad";

wss.on("connection", async (twilioSocket) => {
  console.log("📞 Twilio WebSocket connected");

  const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
  const signedRes = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`, {
    headers: { "xi-api-key": elevenLabsKey }
  });

  const { signed_url } = await signedRes.json();
  if (!signed_url) {
    console.error("❌ Could not get signed ElevenLabs URL");
    twilioSocket.close();
    return;
  }

  const elevenLabsSocket = new WebSocket(signed_url);

  twilioSocket.on("message", (data) => {
    const message = JSON.parse(data);
    if (message.event === "media") {
      const audioData = message.media.payload;
      if (elevenLabsSocket.readyState === WebSocket.OPEN) {
        elevenLabsSocket.send(JSON.stringify({ audio: audioData }));
      }
    }
  });

  elevenLabsSocket.on("message", (data) => {
    const parsed = JSON.parse(data);
    console.log("🗣️ AI:", parsed);
  });

  twilioSocket.on("close", () => {
    console.log("❌ Twilio socket closed");
    elevenLabsSocket.close();
  });

  elevenLabsSocket.on("close", () => {
    console.log("🔌 ElevenLabs socket closed");
  });
});

app.get("/", (req, res) => {
  res.send("🧠 Twilio Stream Handler is running.");
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`✅ Listening on port ${port}`);
});
