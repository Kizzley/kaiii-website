require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const Sentiment = require("sentiment");
const cron = require("node-cron");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const sentiment = new Sentiment();

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

const MAX_INTENSITY = 10;
const MIN_INTENSITY = 1;

/* ===============================
   ROOT
================================ */
app.get("/", (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

/* ===============================
   STORE COMMENT + EVOLVE
================================ */
app.post("/add-comment", async (req, res) => {
  const { username, comment } = req.body;

  try {
    const analysis = sentiment.analyze(comment);

    let mood = "neutral";
    if (analysis.score > 2) mood = "positive";
    if (analysis.score < -2) mood = "negative";

    // Store memory
    await pool.query(
      "INSERT INTO fan_memory (username, comment, sentiment) VALUES ($1, $2, $3)",
      [username, comment, mood]
    );

    // Update personality safely
    if (mood === "positive") {
      await pool.query(`
        UPDATE personality_state
        SET intensity = LEAST(intensity + 1, ${MAX_INTENSITY})
        WHERE trait = 'confidence'
      `);
    }

    if (mood === "negative") {
      await pool.query(`
        UPDATE personality_state
        SET intensity = LEAST(intensity + 1, ${MAX_INTENSITY})
        WHERE trait = 'sensitivity'
      `);
    }

    const response = await generateResponse(mood);

    res.json({
      success: true,
      mood,
      sentiment_score: analysis.score,
      artist_reply: response
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ===============================
   PERSONALITY VIEW
================================ */
app.get("/personality", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT trait, intensity FROM personality_state"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ===============================
   EMOTIONAL TREND
================================ */
app.get("/emotional-trend", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sentiment, COUNT(*) 
      FROM fan_memory
      GROUP BY sentiment
    `);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ===============================
   ENGAGEMENT TRACKING
================================ */
app.post("/engagement", async (req, res) => {
  const { post_id, likes, comments, saves } = req.body;

  try {
    await pool.query(
      "INSERT INTO engagement_stats (post_id, likes, comments, saves) VALUES ($1,$2,$3,$4)",
      [post_id, likes, comments, saves]
    );

    // Boost confidence if engagement high
    if (likes > 1000) {
      await pool.query(`
        UPDATE personality_state
        SET intensity = LEAST(intensity + 1, ${MAX_INTENSITY})
        WHERE trait = 'confidence'
      `);
    }

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ===============================
   RESPONSE GENERATOR
================================ */
async function generateResponse(mood) {
  const personality = await pool.query(
    "SELECT trait, intensity FROM personality_state"
  );

  const traits = {};
  personality.rows.forEach(t => {
    traits[t.trait] = t.intensity;
  });

  if (mood === "positive") {
    if (traits.confidence > 7) {
      return "Your energy fuels my sound. We're building something legendary.";
    }
    return "That means more than you know. Thank you for feeling this with me.";
  }

  if (mood === "negative") {
    if (traits.sensitivity > 7) {
      return "I feel that deeply. Art exists because we feel everything.";
    }
    return "Thank you for being honest. I'm always evolving.";
  }

  return "I appreciate you being here. We're growing together.";
}

/* ===============================
   PERSONALITY DECAY (Hourly)
================================ */
cron.schedule("0 * * * *", async () => {
  try {
    await pool.query(`
      UPDATE personality_state
      SET intensity = GREATEST(intensity - 1, ${MIN_INTENSITY})
    `);
    console.log("Personality decay applied.");
  } catch (err) {
    console.error("Decay error:", err.message);
  }
});

/* ===============================
   SYSTEM STATUS
================================ */
app.get("/status", async (req, res) => {
  try {
    const memoryCount = await pool.query("SELECT COUNT(*) FROM fan_memory");
    const personality = await pool.query("SELECT * FROM personality_state");

    res.json({
      memory_count: memoryCount.rows[0].count,
      personality: personality.rows
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ===============================
   FAN SIGNUP — website email capture
================================ */
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ success: false, error: "Too many requests" })
});

app.post("/api/signup", signupLimiter, async (req, res) => {
  try {
    const { email = "", name = "", honeypot = "" } = req.body;

    // Honeypot check — bots fill this, humans don't
    if (honeypot) return res.json({ success: true });

    // Basic validation
    const cleanEmail = email.trim().toLowerCase();
    const cleanName = name.trim();
    if (!cleanEmail || !cleanEmail.includes("@") || !cleanEmail.includes(".")) {
      return res.status(400).json({ success: false, error: "Invalid email" });
    }

    const username = cleanName || "anonymous";
    const instagram_handle = cleanName.startsWith("@") ? cleanName : null;

    // Check for existing fan
    const existing = await pool.query(
      "SELECT id FROM fans WHERE email = $1 LIMIT 1",
      [cleanEmail]
    );

    if (existing.rows.length > 0) {
      // Fan already exists — just update last seen
      await pool.query(
        "UPDATE fans SET updated_at = NOW() WHERE email = $1",
        [cleanEmail]
      );
    } else {
      // New fan — insert full record
      await pool.query(
        `INSERT INTO fans
        (email, username, instagram_handle, source, tier, is_follower,
         marketing_consent, created_at, updated_at)
        VALUES
        ($1, $2, $3, 'website', 'new', false, true, NOW(), NOW())`,
        [cleanEmail, username, instagram_handle]
      );
    }

    return res.json({ success: true });

  } catch (err) {
    console.error("[/api/signup] error:", err.message);
    return res.json({ success: true }); // never expose errors to client
  }
});

/* ===============================
   START SERVER
================================ */
app.listen(3000, () => {
  console.log("Advanced Digital Artist Brain Running on port 3000");
});