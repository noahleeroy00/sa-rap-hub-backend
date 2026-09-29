const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const { S3Client } = require("@aws-sdk/client-s3");
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


/* =========================
   CLOUDFLARE R2
========================= */

const r2 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
});


/* =========================
   BASIC ROUTES
========================= */

app.get("/", (req, res) => {
    res.json({
        message: "SA Rap Hub backend is running!"
    });
});


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


/* =========================
   PROFILES
========================= */

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
            message: "Failed to load profiles"
        });

    }

});


/* =========================
   CREATE PROFILE
========================= */

app.post("/profiles", async (req, res) => {

    try {

        const {
            username,
            display_name,
            bio,
            account_type
        } = req.body;

        if (!username || !display_name) {

            return res.status(400).json({
                message: "Username and display name are required"
            });

        }

        const result = await pool.query(`
            INSERT INTO profiles
            (
                id,
                username,
                display_name,
                bio,
                account_type
            )
            VALUES
            (
                gen_random_uuid(),
                $1,
                $2,
                $3,
                $4
            )
            RETURNING *
        `, [
            username,
            display_name,
            bio || null,
            account_type || "fan"
        ]);

        res.status(201).json(result.rows[0]);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            message: "Failed to create profile"
        });

    }

});


/* =========================
   SIGN UP
========================= */

app.post("/auth/signup", async (req, res) => {

    try {

        const {
            email,
            password,
            display_name,
            account_type
        } = req.body;

        if (!email || !password || !display_name) {

            return res.status(400).json({
                message: "Email, password and display name are required"
            });

        }

        if (password.length < 6) {

            return res.status(400).json({
                message: "Password must be at least 6 characters"
            });

        }

        const existingAccount = await pool.query(
            "SELECT id FROM accounts WHERE email = $1",
            [email.toLowerCase()]
        );

        if (existingAccount.rows.length > 0) {

            return res.status(409).json({
                message: "An account with this email already exists"
            });

        }

        const passwordHash = await bcrypt.hash(password, 12);

        const username =
            display_name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "_")
                .replace(/^_+|_+$/g, "")
                .slice(0, 50)
            || "user";

        let finalUsername = username;

        let usernameNumber = 1;

        while (true) {

            const usernameCheck = await pool.query(
                "SELECT id FROM profiles WHERE username = $1",
                [finalUsername]
            );

            if (usernameCheck.rows.length === 0) {
                break;
            }

            finalUsername = `${username}_${usernameNumber}`;

            usernameNumber++;

        }

        const client = await pool.connect();

        try {

            await client.query("BEGIN");

            const profileResult = await client.query(`
                INSERT INTO profiles
                (
                    id,
                    username,
                    display_name,
                    account_type
                )
                VALUES
                (
                    gen_random_uuid(),
                    $1,
                    $2,
                    $3
                )
                RETURNING *
            `, [
                finalUsername,
                display_name,
                account_type || "fan"
            ]);

            const profile = profileResult.rows[0];

            const accountResult = await client.query(`
                INSERT INTO accounts
                (
                    id,
                    profile_id,
                    email,
                    password_hash
                )
                VALUES
                (
                    gen_random_uuid(),
                    $1,
                    $2,
                    $3
                )
                RETURNING id, profile_id, email, created_at
            `, [
                profile.id,
                email.toLowerCase(),
                passwordHash
            ]);

            await client.query("COMMIT");

            res.status(201).json({
                message: "Account created successfully",
                account: accountResult.rows[0],
                profile: profile
            });

        } catch (error) {

            await client.query("ROLLBACK");

            throw error;

        } finally {

            client.release();

        }

    } catch (error) {

        console.error(error);

        res.status(500).json({
            message: "Failed to create account"
        });

    }

});


/* =========================
   LOGIN
========================= */

app.post("/auth/login", async (req, res) => {

    try {

        const {
            email,
            password
        } = req.body;

        if (!email || !password) {

            return res.status(400).json({
                message: "Email and password are required"
            });

        }

        const result = await pool.query(`
            SELECT
                a.id AS account_id,
                a.email,
                a.password_hash,
                p.id AS profile_id,
                p.username,
                p.display_name,
                p.bio,
                p.avatar_url,
                p.account_type
            FROM accounts a
            JOIN profiles p
                ON p.id = a.profile_id
            WHERE a.email = $1
        `, [
            email.toLowerCase()
        ]);

        if (result.rows.length === 0) {

            return res.status(401).json({
                message: "Invalid email or password"
            });

        }

        const account = result.rows[0];

        const passwordMatches = await bcrypt.compare(
            password,
            account.password_hash
        );

        if (!passwordMatches) {

            return res.status(401).json({
                message: "Invalid email or password"
            });

        }

        res.json({
            message: "Login successful",
            user: {
                account_id: account.account_id,
                email: account.email,
                profile_id: account.profile_id,
                username: account.username,
                display_name: account.display_name,
                bio: account.bio,
                avatar_url: account.avatar_url,
                account_type: account.account_type
            }
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            message: "Login failed"
        });

    }

});


/* =========================
   POSTS
========================= */

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
                ON profiles.id = posts.user_id

            ORDER BY posts.created_at DESC
        `);

        res.json(result.rows);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            message: "Failed to load posts"
        });

    }

});


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
                message: "Post must contain text or media"
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

        const result = await pool.query(`
            INSERT INTO posts
            (
                id,
                user_id,
                content,
                media_url,
                media_type
            )
            VALUES
            (
                gen_random_uuid(),
                $1,
                $2,
                $3,
                $4
            )
            RETURNING *
        `, [
            user_id,
            content || null,
            media_url || null,
            media_type || null
        ]);

        res.status(201).json(result.rows[0]);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            message: "Failed to create post"
        });

    }

});


/* =========================
   SERVER
========================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

    console.log(
        `SA Rap Hub server running on port ${PORT}`
    );

});
