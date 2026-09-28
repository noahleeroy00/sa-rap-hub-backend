const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// ===============================
// HOME
// ===============================

app.get("/", (req, res) => {
    res.json({
        message: "SA Rap Hub backend is running!"
    });
});

// ===============================
// DATABASE TEST
// ===============================

app.get("/database-test", async (req, res) => {
    try {
        const result = await pool.query("SELECT NOW()");

        res.json({
            message: "SA Rap Hub database is connected!",
            time: result.rows[0].now
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "Database connection failed"
        });
    }
});

// ===============================
// GET ALL PROFILES
// ===============================

app.get("/profiles", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                id,
                username,
                display_name,
                bio,
                avatar_url,
                account_type,
                created_at
            FROM profiles
            ORDER BY created_at DESC
        `);

        res.json(result.rows);
    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "Failed to retrieve profiles"
        });
    }
});

// ===============================
// CREATE PROFILE
// ===============================

app.post("/profiles", async (req, res) => {
    try {
        const {
            username,
            display_name,
            bio,
            avatar_url,
            account_type
        } = req.body;

        if (!username || !display_name) {
            return res.status(400).json({
                message: "Username and display name are required"
            });
        }

        const result = await pool.query(
            `
            INSERT INTO profiles (
                id,
                username,
                display_name,
                bio,
                avatar_url,
                account_type
            )
            VALUES (
                gen_random_uuid(),
                $1,
                $2,
                $3,
                $4,
                $5
            )
            RETURNING *
            `,
            [
                username,
                display_name,
                bio || null,
                avatar_url || null,
                account_type || "fan"
            ]
        );

        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error(error);

        if (error.code === "23505") {
            return res.status(409).json({
                message: "Username already exists"
            });
        }

        res.status(500).json({
            message: "Failed to create profile"
        });
    }
});

// ===============================
// GET ALL POSTS
// ===============================

app.get("/posts", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                posts.id,
                posts.content,
                posts.media_url,
                posts.media_type,
                posts.created_at,
                profiles.id AS user_id,
                profiles.username,
                profiles.display_name,
                profiles.avatar_url,
                profiles.account_type
            FROM posts
            JOIN profiles
                ON posts.user_id = profiles.id
            ORDER BY posts.created_at DESC
        `);

        res.json(result.rows);
    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "Failed to retrieve posts"
        });
    }
});

// ===============================
// CREATE POST
// ===============================

app.post("/posts", async (req, res) => {
    try {
        const {
            user_id,
            content,
            media_url,
            media_type
        } = req.body;

        if (!user_id) {
            return res.status(400).json({
                message: "user_id is required"
            });
        }

        if (!content && !media_url) {
            return res.status(400).json({
                message: "A post must contain text or media"
            });
        }

        if (
            media_type &&
            !["image", "video"].includes(media_type)
        ) {
            return res.status(400).json({
                message: "media_type must be image or video"
            });
        }

        const result = await pool.query(
            `
            INSERT INTO posts (
                id,
                user_id,
                content,
                media_url,
                media_type
            )
            VALUES (
                gen_random_uuid(),
                $1,
                $2,
                $3,
                $4
            )
            RETURNING *
            `,
            [
                user_id,
                content || null,
                media_url || null,
                media_type || null
            ]
        );

        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error(error);

        if (error.code === "23503") {
            return res.status(404).json({
                message: "User profile not found"
            });
        }

        res.status(500).json({
            message: "Failed to create post"
        });
    }
});

// ===============================
// START SERVER
// ===============================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`SA Rap Hub server running on port ${PORT}`);
});
