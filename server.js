const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const { randomUUID } = require("crypto");

const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand
} = require("@aws-sdk/client-s3");

require("dotenv").config();


/* =========================================================
   APP CONFIGURATION
========================================================= */

const app = express();

const PORT = process.env.PORT || 3000;

const API_URL =
    process.env.API_URL ||
    "https://sa-rap-hub-api.onrender.com";

const R2_BUCKET =
    process.env.R2_BUCKET_NAME;


/* =========================================================
   MIDDLEWARE
========================================================= */

app.use(cors());

app.use(
    express.json({
        limit: "1mb"
    })
);


/*
   Images and videos are uploaded as raw binary data.
   Maximum file size: 30 MB.
*/
const mediaUploadParser = express.raw({
    type: [
        "image/*",
        "video/*"
    ],
    limit: "30mb"
});


/* =========================================================
   DATABASE
========================================================= */

const pool = new Pool({

    connectionString:
        process.env.DATABASE_URL,

    ssl: {
        rejectUnauthorized: false
    }

});


/* =========================================================
   CLOUDFLARE R2
========================================================= */

const r2 = new S3Client({

    region: "auto",

    endpoint:
        process.env.R2_ENDPOINT,

    credentials: {

        accessKeyId:
            process.env.R2_ACCESS_KEY_ID,

        secretAccessKey:
            process.env.R2_SECRET_ACCESS_KEY

    }

});


/* =========================================================
   HELPER FUNCTIONS
========================================================= */

function getFileExtension(contentType) {

    const extensions = {

        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",

        "video/mp4": ".mp4",
        "video/webm": ".webm",
        "video/quicktime": ".mov",
        "video/ogg": ".ogv"

    };

    return extensions[contentType] || "";
}


function getMediaType(contentType) {

    if (contentType.startsWith("image/")) {
        return "image";
    }

    if (contentType.startsWith("video/")) {
        return "video";
    }

    return null;
}


function isAllowedMediaType(contentType) {

    const allowedTypes = [

        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",

        "video/mp4",
        "video/webm",
        "video/quicktime",
        "video/ogg"

    ];

    return allowedTypes.includes(contentType);
}


async function profileExists(profileId) {

    const result =
        await pool.query(
            `
            SELECT id
            FROM profiles
            WHERE id = $1
            `,
            [profileId]
        );

    return result.rows.length > 0;
}


/* =========================================================
   HOME
========================================================= */

app.get("/", (req, res) => {

    res.json({

        name: "SA Rap Hub API",

        status: "online",

        version: "1.0.0"

    });

});


/* =========================================================
   PROFILES
========================================================= */

app.get("/profiles", async (req, res) => {

    try {

        const result =
            await pool.query(
                `
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
                `
            );


        res.json(result.rows);


    } catch (error) {

        console.error(
            "GET /profiles:",
            error
        );


        res.status(500).json({

            message:
                "Failed to load profiles"

        });

    }

});


/* =========================================================
   CREATE PROFILE
========================================================= */

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

                message:
                    "Username and display name are required"

            });

        }


        const result =
            await pool.query(
                `
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
                `,
                [

                    username
                        .trim(),

                    display_name
                        .trim(),

                    bio || null,

                    account_type || "fan"

                ]
            );


        res.status(201).json(
            result.rows[0]
        );


    } catch (error) {

        console.error(
            "POST /profiles:",
            error
        );


        if (error.code === "23505") {

            return res.status(409).json({

                message:
                    "Username already exists"

            });

        }


        res.status(500).json({

            message:
                "Failed to create profile"

        });

    }

});


/* =========================================================
   SIGN UP
========================================================= */

app.post("/auth/signup", async (req, res) => {

    const client =
        await pool.connect();


    try {

        const {

            email,
            password,
            display_name,
            account_type

        } = req.body;


        if (
            !email ||
            !password ||
            !display_name
        ) {

            return res.status(400).json({

                message:
                    "Email, password and display name are required"

            });

        }


        if (password.length < 6) {

            return res.status(400).json({

                message:
                    "Password must be at least 6 characters"

            });

        }


        const cleanEmail =
            email
                .trim()
                .toLowerCase();


        const existingAccount =
            await client.query(
                `
                SELECT id
                FROM accounts
                WHERE email = $1
                `,
                [cleanEmail]
            );


        if (
            existingAccount.rows.length > 0
        ) {

            return res.status(409).json({

                message:
                    "An account with this email already exists"

            });

        }


        const passwordHash =
            await bcrypt.hash(
                password,
                12
            );


        let username =
            display_name
                .trim()
                .toLowerCase()
                .replace(
                    /[^a-z0-9]+/g,
                    "_"
                )
                .replace(
                    /^_+|_+$/g,
                    ""
                )
                .slice(0, 50);


        if (!username) {

            username = "user";

        }


        let finalUsername =
            username;

        let usernameNumber = 1;


        while (true) {

            const usernameCheck =
                await client.query(
                    `
                    SELECT id
                    FROM profiles
                    WHERE username = $1
                    `,
                    [finalUsername]
                );


            if (
                usernameCheck.rows.length === 0
            ) {

                break;

            }


            finalUsername =
                `${username}_${usernameNumber}`;

            usernameNumber++;

        }


        await client.query("BEGIN");


        const profileResult =
            await client.query(
                `
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
                `,
                [

                    finalUsername,

                    display_name.trim(),

                    account_type || "fan"

                ]
            );


        const profile =
            profileResult.rows[0];


        const accountResult =
            await client.query(
                `
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

                RETURNING

                    id,
                    profile_id,
                    email,
                    created_at
                `,
                [

                    profile.id,

                    cleanEmail,

                    passwordHash

                ]
            );


        await client.query("COMMIT");


        res.status(201).json({

            message:
                "Account created successfully",

            account:
                accountResult.rows[0],

            profile

        });


    } catch (error) {

        await client.query("ROLLBACK");


        console.error(
            "POST /auth/signup:",
            error
        );


        if (error.code === "23505") {

            return res.status(409).json({

                message:
                    "Email or username already exists"

            });

        }


        res.status(500).json({

            message:
                "Failed to create account"

        });


    } finally {

        client.release();

    }

});


/* =========================================================
   LOGIN
========================================================= */

app.post("/auth/login", async (req, res) => {

    try {

        const {

            email,
            password

        } = req.body;


        if (!email || !password) {

            return res.status(400).json({

                message:
                    "Email and password are required"

            });

        }


        const cleanEmail =
            email
                .trim()
                .toLowerCase();


        const result =
            await pool.query(
                `
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
                `,
                [cleanEmail]
            );


        if (
            result.rows.length === 0
        ) {

            return res.status(401).json({

                message:
                    "Invalid email or password"

            });

        }


        const account =
            result.rows[0];


        const passwordMatches =
            await bcrypt.compare(
                password,
                account.password_hash
            );


        if (!passwordMatches) {

            return res.status(401).json({

                message:
                    "Invalid email or password"

            });

        }


        res.json({

            message:
                "Login successful",

            user: {

                account_id:
                    account.account_id,

                email:
                    account.email,

                profile_id:
                    account.profile_id,

                username:
                    account.username,

                display_name:
                    account.display_name,

                bio:
                    account.bio,

                avatar_url:
                    account.avatar_url,

                account_type:
                    account.account_type

            }

        });


    } catch (error) {

        console.error(
            "POST /auth/login:",
            error
        );


        res.status(500).json({

            message:
                "Login failed"

        });

    }

});


/* =========================================================
   MEDIA UPLOAD
========================================================= */

app.post(
    "/media/upload",
    mediaUploadParser,
    async (req, res) => {

        try {

            const userId =
                req.headers["x-user-id"];

            const contentType =
                req.headers["content-type"];


            /* -----------------------------------------
               CHECK USER
            ----------------------------------------- */

            if (!userId) {

                return res.status(401).json({

                    message:
                        "User authentication is required"

                });

            }


            const userExists =
                await profileExists(
                    userId
                );


            if (!userExists) {

                return res.status(401).json({

                    message:
                        "User account was not found"

                });

            }


            /* -----------------------------------------
               CHECK FILE
            ----------------------------------------- */

            if (
                !req.body ||
                !Buffer.isBuffer(req.body)
            ) {

                return res.status(400).json({

                    message:
                        "No media file was received"

                });

            }


            if (req.body.length === 0) {

                return res.status(400).json({

                    message:
                        "Uploaded file is empty"

                });

            }


            if (!contentType) {

                return res.status(400).json({

                    message:
                        "Content-Type is required"

                });

            }


            if (
                !isAllowedMediaType(
                    contentType
                )
            ) {

                return res.status(415).json({

                    message:
                        "This image or video format is not supported"

                });

            }


            const mediaType =
                getMediaType(
                    contentType
                );


            const extension =
                getFileExtension(
                    contentType
                );


            if (
                !mediaType ||
                !extension
            ) {

                return res.status(415).json({

                    message:
                        "Unsupported media format"

                });

            }


            /* -----------------------------------------
               CREATE R2 KEY
            ----------------------------------------- */

            const key =
                `users/${userId}/media/${randomUUID()}${extension}`;


            /* -----------------------------------------
               UPLOAD TO CLOUDFLARE R2
            ----------------------------------------- */

            await r2.send(

                new PutObjectCommand({

                    Bucket:
                        R2_BUCKET,

                    Key:
                        key,

                    Body:
                        req.body,

                    ContentType:
                        contentType,

                    CacheControl:
                        "public, max-age=31536000, immutable"

                })

            );


            /* -----------------------------------------
               PERMANENT MEDIA URL
            ----------------------------------------- */

            const mediaUrl =
                `${API_URL}/media/${key}`;


            res.status(201).json({

                message:
                    "Media uploaded successfully",

                key,

                media_url:
                    mediaUrl,

                media_type:
                    mediaType,

                content_type:
                    contentType,

                size:
                    req.body.length

            });


        } catch (error) {

            console.error(
                "POST /media/upload:",
                error
            );


            res.status(500).json({

                message:
                    "Failed to upload media"

            });

        }

    }
);


/* =========================================================
   SERVE MEDIA FROM PRIVATE R2
========================================================= */

/*
   IMPORTANT:

   Express 5 wildcard parameters are arrays.

   Example:

   /media/users/123/media/photo.jpg

   becomes:

   req.params.key = [
       "users",
       "123",
       "media",
       "photo.jpg"
   ]

   We join the pieces back together before
   asking Cloudflare R2 for the object.
*/

app.get(
    "/media/*key",
    async (req, res) => {

        try {

            const keyParts =
                req.params.key;


            const key =
                Array.isArray(keyParts)
                    ? keyParts.join("/")
                    : keyParts;


            if (!key) {

                return res.status(400).json({

                    message:
                        "Media key is required"

                });

            }


            /* -----------------------------------------
               GET FILE INFORMATION
            ----------------------------------------- */

            let metadata;


            try {

                metadata =
                    await r2.send(

                        new HeadObjectCommand({

                            Bucket:
                                R2_BUCKET,

                            Key:
                                key

                        })

                    );


            } catch (error) {

                if (
                    error.name === "NotFound" ||
                    error.$metadata?.httpStatusCode === 404
                ) {

                    return res.status(404).json({

                        message:
                            "Media not found"

                    });

                }


                throw error;

            }


            const fileSize =
                Number(
                    metadata.ContentLength || 0
                );


            const contentType =
                metadata.ContentType ||
                "application/octet-stream";


            /* -----------------------------------------
               RESPONSE HEADERS
            ----------------------------------------- */

            res.setHeader(
                "Content-Type",
                contentType
            );


            res.setHeader(
                "Accept-Ranges",
                "bytes"
            );


            res.setHeader(
                "Cache-Control",
                "public, max-age=31536000, immutable"
            );


            /* -----------------------------------------
               VIDEO RANGE REQUEST
            ----------------------------------------- */

            const range =
                req.headers.range;


            if (range) {

                const match =
                    range.match(
                        /^bytes=(\d*)-(\d*)$/
                    );


                if (!match) {

                    res.setHeader(
                        "Content-Range",
                        `bytes */${fileSize}`
                    );

                    return res.status(416).end();

                }


                let start =
                    match[1]
                        ? Number(match[1])
                        : 0;


                let end =
                    match[2]
                        ? Number(match[2])
                        : fileSize - 1;


                if (!match[1]) {

                    const suffixLength =
                        Number(match[2]);


                    start =
                        Math.max(
                            fileSize - suffixLength,
                            0
                        );


                    end =
                        fileSize - 1;

                }


                if (
                    start < 0 ||
                    end >= fileSize ||
                    start > end
                ) {

                    res.setHeader(
                        "Content-Range",
                        `bytes */${fileSize}`
                    );

                    return res.status(416).end();

                }


                const contentLength =
                    end - start + 1;


                res.status(206);


                res.setHeader(
                    "Content-Range",
                    `bytes ${start}-${end}/${fileSize}`
                );


                res.setHeader(
                    "Content-Length",
                    contentLength
                );


                const object =
                    await r2.send(

                        new GetObjectCommand({

                            Bucket:
                                R2_BUCKET,

                            Key:
                                key,

                            Range:
                                `bytes=${start}-${end}`

                        })

                    );


                object.Body.pipe(res);

                return;

            }


            /* -----------------------------------------
               NORMAL FILE REQUEST
            ----------------------------------------- */

            res.setHeader(
                "Content-Length",
                fileSize
            );


            const object =
                await r2.send(

                    new GetObjectCommand({

                        Bucket:
                            R2_BUCKET,

                        Key:
                            key

                    })

                );


            object.Body.pipe(res);


        } catch (error) {

            console.error(
                "GET /media:",
                error
            );


            if (!res.headersSent) {

                res.status(500).json({

                    message:
                        "Failed to load media"

                });

            }

        }

    }
);


/* =========================================================
   GET POSTS
========================================================= */

app.get("/posts", async (req, res) => {

    try {

        const result =
            await pool.query(
                `
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

                ORDER BY
                    posts.created_at DESC
                `
            );


        res.json(
            result.rows
        );


    } catch (error) {

        console.error(
            "GET /posts:",
            error
        );


        res.status(500).json({

            message:
                "Failed to load posts"

        });

    }

});


/* =========================================================
   CREATE POST
========================================================= */

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

                message:
                    "user_id is required"

            });

        }


        const userExists =
            await profileExists(
                user_id
            );


        if (!userExists) {

            return res.status(401).json({

                message:
                    "User account was not found"

            });

        }


        if (
            !content &&
            !media_url
        ) {

            return res.status(400).json({

                message:
                    "Post must contain text or media"

            });

        }


        if (
            media_type &&
            !["image", "video"]
                .includes(media_type)
        ) {

            return res.status(400).json({

                message:
                    "media_type must be image or video"

            });

        }


        const result =
            await pool.query(
                `
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
                `,
                [

                    user_id,

                    content
                        ? content.trim()
                        : null,

                    media_url || null,

                    media_type || null

                ]
            );


        res.status(201).json(
            result.rows[0]
        );


    } catch (error) {

        console.error(
            "POST /posts:",
            error
        );


        res.status(500).json({

            message:
                "Failed to create post"

        });

    }

});


/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
    (error, req, res, next) => {

        console.error(
            "Unhandled error:",
            error
        );


        if (
            error.type ===
            "entity.too.large"
        ) {

            return res.status(413).json({

                message:
                    "File is too large. Maximum size is 30 MB."

            });

        }


        if (res.headersSent) {

            return next(error);

        }


        res.status(500).json({

            message:
                "An unexpected server error occurred"

        });

    }
);


/* =========================================================
   START SERVER
========================================================= */

app.listen(
    PORT,
    () => {

        console.log(
            `SA Rap Hub API running on port ${PORT}`
        );

    }
);
