const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);

  if (pathname === "/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});



const AGENT_ID = process.env.AGENT_ID || "aiBrad";
const ENABLE_TRANSCRIPTION = process.env.TRANSCRIPT_LOGGING === "true";

app.use(express.json());

// ✅ POST /init — ElevenLabs personalization webhook
app.post("/init", (req, res) => {
  const { caller_id, agent_id, called_number, call_sid } = req.body;

  console.log("📡 ElevenLabs requested call init for:", caller_id);

  const responseData = {
    type: "conversation_initiation_client_data",
    dynamic_variables: {
      caller_name: "Brad",
      last_interaction: "friendly and recent",
    },
    conversation_config_override: {
      agent: {
        prompt: {
          prompt: "You are aiBrad, the digital twin of Brad Harvey, founder of Dexter Co. You are warm, witty, and insightful."
        },
        first_message: "Hey there — this is aiBrad. What’s on your mind today?",
        language: "en"
      },
      tts: {
        voice_id: "YOUR_ELEVENLABS_VOICE_ID" // Replace with your actual voice_id
      }
    }
  };

  res.json(responseData);
});

// ✅ POST /twilio — Updated to point Twilio to the correct WebSocket path
app.post("/twilio", express.text({ type: "*/*" }), (req, res) => {
  const response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="wss://${req.headers.host}/ws" />
  </Start>
</Response>`.trim();

  res.set("Content-Type", "text/xml");
  res.status(200).send(response);
});


// ✅ WebSocket relay: Twilio → ElevenLabs
wss.on("connection", async (twilioSocket) => {
  console.log("📞 Twilio WebSocket connected");

  try {
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

    elevenSocket.on("message", (data) => {
      try {
        const parsed = JSON.parse(data);
        console.log("🗣️ ElevenLabs AI:", parsed);
      } catch (err) {
        console.error("⚠️ Error parsing ElevenLabs message:", err);
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
    console.error("❌ Error setting up WebSocket relay:", err);
    twilioSocket.close();
  }
});

// ✅ GET / — Health check
app.get("/", (req, res) => {
  res.send("🧠 Twilio → ElevenLabs relay server is live.");
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`✅ Listening on port ${PORT}`);
});
