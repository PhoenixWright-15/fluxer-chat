// =============================================================================
// Fluxer Chat — Backend Server
// =============================================================================
// Express + WebSocket server with CORS configured for GitHub Pages origin.
// Connects to Neon PostgreSQL via DATABASE_URL.
// =============================================================================

import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import pg from "pg";
import { randomUUID } from "crypto";

const { Pool } = pg;

// ── Configuration ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "10000", 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL is required. Set it to your Neon connection string.");
  process.exit(1);
}

// ── Database ────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Required for Neon serverless
  max: 5,                             // Conservative pool size for free tier
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Initialize schema on startup
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username   VARCHAR(50)  NOT NULL,
        content    TEXT         NOT NULL,
        room       VARCHAR(100) NOT NULL DEFAULT 'general',
        created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_messages_room_created
        ON messages (room, created_at DESC);
    `);
    console.log("✅ Database schema initialized");
  } finally {
    client.release();
  }
}

// ── Express App ─────────────────────────────────────────────────────────────

const app = express();

app.use(cors({
  origin: CORS_ORIGIN,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
}));

app.use(express.json());

// Health check — used by Render, GitHub Actions keep-alive, and Docker
app.get("/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW() AS server_time");
    res.json({
      status: "ok",
      timestamp: result.rows[0].server_time,
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || "development",
    });
  } catch (err) {
    res.status(503).json({
      status: "degraded",
      error: "Database connection failed",
    });
  }
});

// GET /api/messages?room=general&limit=50 — Fetch recent messages
app.get("/api/messages", async (req, res) => {
  const room = req.query.room || "general";
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);

  try {
    const result = await pool.query(
      `SELECT id, username, content, room, created_at
       FROM messages
       WHERE room = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [room, limit]
    );
    res.json(result.rows.reverse()); // Return in chronological order
  } catch (err) {
    console.error("Error fetching messages:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// ── HTTP Server & WebSocket ─────────────────────────────────────────────────

const server = createServer(app);

const wss = new WebSocketServer({
  server,
  path: "/ws",
  // Verify origin to prevent unauthorized WebSocket connections
  verifyClient: (info) => {
    const origin = info.origin || info.req.headers.origin;
    // Allow connections from the configured CORS origin and health checks
    if (!origin) return true; // Server-to-server (health checks, etc.)
    return origin === CORS_ORIGIN || origin === `http://localhost:${PORT}`;
  },
});

// Track connected clients by room
const rooms = new Map(); // room -> Set<ws>

wss.on("connection", (ws, req) => {
  const clientId = randomUUID().slice(0, 8);
  let currentRoom = "general";

  console.log(`🔌 Client ${clientId} connected`);

  // Add to default room
  joinRoom(ws, currentRoom);

  // Send recent message history on connect
  sendHistory(ws, currentRoom);

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      switch (data.type) {
        case "message": {
          const { username, content, room } = data;
          if (!username || !content) return;

          const targetRoom = room || currentRoom;

          // Persist to database
          const result = await pool.query(
            `INSERT INTO messages (username, content, room)
             VALUES ($1, $2, $3)
             RETURNING id, username, content, room, created_at`,
            [username.slice(0, 50), content.slice(0, 2000), targetRoom]
          );

          const saved = result.rows[0];

          // Broadcast to all clients in the room
          broadcast(targetRoom, {
            type: "message",
            ...saved,
          });
          break;
        }

        case "join": {
          const newRoom = data.room || "general";
          leaveRoom(ws, currentRoom);
          currentRoom = newRoom;
          joinRoom(ws, currentRoom);
          sendHistory(ws, currentRoom);
          break;
        }

        case "ping": {
          ws.send(JSON.stringify({ type: "pong" }));
          break;
        }
      }
    } catch (err) {
      console.error(`Error processing message from ${clientId}:`, err);
    }
  });

  ws.on("close", () => {
    leaveRoom(ws, currentRoom);
    console.log(`🔌 Client ${clientId} disconnected`);
  });

  ws.on("error", (err) => {
    console.error(`WebSocket error for ${clientId}:`, err.message);
  });
});

// ── Room Helpers ────────────────────────────────────────────────────────────

function joinRoom(ws, room) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(ws);
}

function leaveRoom(ws, room) {
  const members = rooms.get(room);
  if (members) {
    members.delete(ws);
    if (members.size === 0) rooms.delete(room);
  }
}

function broadcast(room, message) {
  const payload = JSON.stringify(message);
  const members = rooms.get(room);
  if (!members) return;

  for (const client of members) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

async function sendHistory(ws, room) {
  try {
    const result = await pool.query(
      `SELECT id, username, content, room, created_at
       FROM messages WHERE room = $1
       ORDER BY created_at DESC LIMIT 50`,
      [room]
    );
    ws.send(JSON.stringify({
      type: "history",
      messages: result.rows.reverse(),
    }));
  } catch (err) {
    console.error("Error sending history:", err);
  }
}

// ── WebSocket heartbeat to detect stale connections ─────────────────────────

const HEARTBEAT_INTERVAL = 30000; // 30 seconds

function heartbeat() {
  this.isAlive = true;
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);
});

const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

wss.on("close", () => clearInterval(heartbeatTimer));

// ── Start Server ────────────────────────────────────────────────────────────

async function start() {
  try {
    await initDatabase();
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Fluxer Chat backend running on port ${PORT}`);
      console.log(`   CORS origin: ${CORS_ORIGIN}`);
      console.log(`   WebSocket:   ws://0.0.0.0:${PORT}/ws`);
      console.log(`   Health:      http://0.0.0.0:${PORT}/health`);
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err);
    process.exit(1);
  }
}

start();
