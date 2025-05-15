require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fetch = require("node-fetch");

const app = express();
const server = http.createServer(app);

const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

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

app.post("/twilio", (req, res) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <Response>
    <Start>
      <Stream url="wss://twilio-elevenlabs-relay.onrender.com/ws" />
    </Start>
    <Say voice="Polly.Joanna">Testing AI voice. Please hold.</Say>
    <Pause length="20"/>
  </Response>`;
  res.type("text/xml").send(xml);
});

app.post("/init", express.json(), (req, res) => {
  res.json({
    type: "conversation_initiation_client_data",
    start_conversation: true,
    conversation_config_override: {
      agent: {
        prompt: {
          prompt: "You are a test AI voice system."
        },
        first_message: "Testing AI voice system.",
        language: "en"
      },
      tts: {
        voice_id: "EXAVITQu4vr4xnSDxMaL"
      }
    },
    dynamic_variables: {
      caller_name: "Tester",
      last_interaction: "testing"
    }
  });
});

wss.on("connection", async (twilioSocket) => {
  let audioQueue = [];
  let streamSidReady = false;

  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${AGENT_ID}`,
    { headers: { "xi-api-key": ELEVENLABS_API_KEY } }
  );

  const { signed_url } = await res.json();
  const elevenSocket = new WebSocket(signed_url);

  elevenSocket.on("open", () => {
    elevenSocket.send(JSON.stringify({
      agent_id: AGENT_ID,
      session_id: `twilio-test-${Date.now()}`
    }));
  });

  twilioSocket.on("message", (data) => {
    const msg = JSON.parse(data);

    if (msg.event === "start") {
      const sid = msg.streamSid || msg.start?.streamSid;
      if (sid) {
        twilioSocket.streamSid = sid;
        streamSidReady = true;

        while (audioQueue.length > 0) {
          const base64 = audioQueue.shift();
          twilioSocket.send(JSON.stringify({
            event: "media",
            streamSid: sid,
            media: { payload: base64 }
          }));
        }

        const testText = "This is a test message from AI Brad. Please confirm you can hear this clearly.";
        const sendBrad = (text) => {
          if (elevenSocket.readyState === WebSocket.OPEN) {
            elevenSocket.send(JSON.stringify({
              type: "agent_response_event",
              audio_behavior: "immediate",
              text
            }));
          }
        };

        sendBrad(testText);
        setTimeout(() => sendBrad(testText), 3000);
        setTimeout(() => sendBrad("Still testing the voice system."), 6000);
        setTimeout(() => sendBrad("This is the final check."), 9000);
      }
    }

    if (msg.event === "media" && msg.media?.payload && elevenSocket.readyState === WebSocket.OPEN) {
      elevenSocket.send(JSON.stringify({
        type: "user_audio",
        audio: msg.media.payload
      }));
    }
  });

  elevenSocket.on("message", (data) => {
    const msg = JSON.parse(data);
    if (msg.type === "audio" && msg.audio_event?.audio_base_64 && twilioSocket.readyState === WebSocket.OPEN) {
      const base64 = msg.audio_event.audio_base_64;
      if (!streamSidReady || !twilioSocket.streamSid) {
        console.warn("⚠️ Buffering ElevenLabs audio until streamSid ready.");
        audioQueue.push(base64);
        return;
      }

      twilioSocket.send(JSON.stringify({
        event: "media",
        streamSid: twilioSocket.streamSid,
        media: { payload: base64 }
      }));
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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Listening on port ${PORT}`);
});