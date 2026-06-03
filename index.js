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

const app = express();
let latestQR = null;
let botStarted = false;

// Stores pending TikTok download requests: jid -> { url, videoUrl, audioUrl }
const pendingTT = new Map();

// Anti-delete: chats where it's enabled, and cache of recent messages
const antidelChats = new Set();
const messageCache = new Map(); // msgId -> { from, text, pushName, hasMedia, mediaType }

// View-once cache: auto-download when view-once arrives so .vv can retrieve it
const viewOnceCache = new Map(); // msgId -> { buffer, isImage }

// Ensure auth folder exists
if (!fs.existsSync('./auth')) {
    fs.mkdirSync('./auth');
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

async function sendVideo(tmpFile, sock, from, msg, reply) {
    try {
        const buffer = fs.readFileSync(tmpFile);
        await sock.sendMessage(from, {
            video: buffer,
            mimetype: 'video/mp4',
            caption: '✅ Here is your video'
        }, { quoted: msg });
    } catch (sendErr) {
        console.error('Send error:', sendErr);
        reply('❌ Downloaded but failed to send. Video may be too large (WhatsApp limit is ~64MB).');
    } finally {
        try { fs.unlinkSync(tmpFile); } catch (e) {}
    }
}

async function startBot() {
    if (botStarted) return;
    botStarted = true;

    const { state, saveCreds } = await useMultiFileAuthState('./auth');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });

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

        if (!msg.key.fromMe && (cmd.includes('as salamu alaykum') || cmd.includes('assalamu alaykum') || cmd.includes('assalamualaikum') || cmd.includes('salam'))) {
            await reply('Wa alaykum as salam wa rahmatullahi wa barakatuh. 🤍');
            try {
                const salamAudio = fs.readFileSync('./salam_reply.ogg');
                await sock.sendMessage(from, {
                    audio: salamAudio,
                    mimetype: 'audio/ogg; codecs=opus',
                    ptt: true,
                    seconds: 30
                }, { quoted: msg });
            } catch (e) {
                console.error('Salam audio send error:', e);
            }
        }

        if (cmd === 'menu') {
            const menuText = `╭━━━〔 🤖 X BOT 🤖 〕━━━╮
┃
┃ 👑 Owner : xman
┃ 🌍 Location : Sri Lanka
┃ ⚡️ Version : 1.0
┃ 🟢 Status : Active
┃
╰━━━━━━━━━━━━━━━━━━━╯

『 📌 COMMAND MENU 』

➤ As salamu alaykum
   └ Islamic greeting reply

➤ menu
   └ Display all commands

➤ ping
   └ Check bot response speed

➤ .video <YouTube Link>
   └ Download video

➤ .song <YouTube Link>
   └ Download song/audio

➤ .insta <Instagram Link>
   └ Download Instagram video

➤ .fb <Facebook Link>
   └ Download Facebook video

➤ .tt <TikTok Link>
   └ Download TikTok video

━━━━━━━━━━━━━━━━━━━

🌙 X BOT • Made with ❤️
👑 Created by xman
🇱🇰 Sri Lanka`;
            await reply('Wa alaykum as salam wa rahmatullahi wa barakatuh. 🤍');
            try {
                const salamAudio = fs.readFileSync('./salam_reply.ogg');
                await sock.sendMessage(from, {
                    audio: salamAudio,
                    mimetype: 'audio/ogg; codecs=opus',
                    ptt: true,
                    seconds: 30
                });
            } catch (e) {
                console.error('Menu salam audio error:', e);
            }
            await sock.sendMessage(from, {
                image: fs.readFileSync('./menu.png'),
                caption: menuText
            }, { quoted: msg });
        }

        if (cmd === 'ping') {
            await reply('pong 🏓');
        }

        if (cmd === '.vv') {
            const ctx = msg.message?.extendedTextMessage?.contextInfo;
            const stanzaId = ctx?.stanzaId;

            console.log('[.vv CMD] stanzaId:', stanzaId, '| cache keys:', [...viewOnceCache.keys()]);

            if (!stanzaId) {
                return reply('❌ Reply to a view once photo or video with .vv');
            }

            const cached = viewOnceCache.get(stanzaId);
            if (!cached) {
                return reply(`❌ View once media not found in cache.\n\nℹ️ Debug: looking for ID ${stanzaId}\nCache has ${viewOnceCache.size} item(s): ${[...viewOnceCache.keys()].join(', ') || 'none'}`);
            }

            try {
                if (cached.isImage) {
                    await sock.sendMessage(from, { image: cached.buffer, caption: '📸 *View Once Image — Saved*' });
                } else {
                    await sock.sendMessage(from, { video: cached.buffer, caption: '🎥 *View Once Video — Saved*' });
                }
                viewOnceCache.delete(stanzaId);
            } catch (e) {
                console.error('.vv send error:', e);
                await reply('❌ Failed to send the saved media.');
            }
            return;
        }

        if (cmd === '.antidel on' || cmd === '.antidel off') {
            const ownerNumber = '94720552037';
            const senderNumber = from.replace(/[^0-9]/g, '').replace(/:\d+$/, '');
            if (senderNumber !== ownerNumber && !msg.key.fromMe) {
                await reply('⛔ Only the owner can use this command.');
                return;
            }
            if (cmd === '.antidel on') {
                antidelChats.add(from);
                await reply('🛡️ Anti-Delete *ON* — deleted messages will be revealed.');
            } else {
                antidelChats.delete(from);
                await reply('❌ Anti-Delete *OFF*');
            }
            return;
        }

        if (text.trim().toLowerCase().startsWith('.song')) {
            const urlMatch = text.match(/(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[\w\-?=&]+)/i);
            if (!urlMatch) return reply('❌ Please send a valid YouTube link.\nExample: .song https://youtu.be/xxxxx');

            const url = urlMatch[1];
            await reply('⏳ Downloading audio... please wait');

            const tmpFile = path.join(os.tmpdir(), `wa_audio_${Date.now()}.mp3`);
            const command = `yt-dlp --extractor-args "youtube:player_client=android,ios,mweb" -x --audio-format mp3 --audio-quality 128K -o "${tmpFile}" --no-playlist "${url}"`;

            exec(command, { timeout: 120000 }, async (err, stdout, stderr) => {
                if (err) {
                    console.error('audio download failed:', stderr);
                    return reply('❌ Could not download audio. The video may be unavailable.');
                }
                try {
                    const buffer = fs.readFileSync(tmpFile);
                    await sock.sendMessage(from, {
                        audio: buffer,
                        mimetype: 'audio/mpeg',
                        ptt: false
                    }, { quoted: msg });
                } catch (sendErr) {
                    console.error('Send audio error:', sendErr);
                    reply('❌ Downloaded but failed to send the audio.');
                } finally {
                    try { fs.unlinkSync(tmpFile); } catch (e) {}
                }
            });
        }

        if (text.trim().toLowerCase().startsWith('.insta')) {
            const urlMatch = text.match(/(https?:\/\/(?:www\.)?instagram\.com\/[\w\/\?\-\=\&\.]+)/i);
            if (!urlMatch) return reply('❌ Please send a valid Instagram link.\nExample: .insta https://www.instagram.com/p/xxxxx');
            await reply('⏳ Downloading Instagram video... please wait');
            await downloadSocialVideo(urlMatch[1], sock, from, msg, reply);
        }

        if (text.trim().toLowerCase().startsWith('.fb')) {
            const urlMatch = text.match(/(https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\/[\w\/\?\-\=\&\.]+|https?:\/\/fb\.watch\/[\w\-]+)/i);
            if (!urlMatch) return reply('❌ Please send a valid Facebook link.\nExample: .fb https://www.facebook.com/watch?v=xxxxx');
            await reply('⏳ Downloading Facebook video... please wait');
            await downloadSocialVideo(urlMatch[1], sock, from, msg, reply);
        }

        if (text.trim().toLowerCase().startsWith('.tt')) {
            const urlMatch = text.match(/(https?:\/\/(?:www\.|vm\.|vt\.)?tiktok\.com\/@[\w.]+\/video\/\d+[\w?=&]*|https?:\/\/(?:vm|vt)\.tiktok\.com\/[\w]+\/?)/i);
            if (!urlMatch) return reply('❌ Please send a valid TikTok video link.\nExample: .tt https://vm.tiktok.com/xxxxx');
            const url = urlMatch[1];
            await reply('⏳ Fetching TikTok info...');
            try {
                const result = await TikTokDownloader(url, { version: 'v3' });
                if (result.status !== 'success' || !result.result) {
                    return reply('❌ Could not fetch TikTok video. It may be private or deleted.');
                }
                const videoUrl = result.result.videoHD || result.result.videoSD;
                const audioUrl = result.result.videoSD || videoUrl;
                if (!videoUrl) return reply('❌ No downloadable video found for this TikTok.');
                pendingTT.set(from, { videoUrl, audioUrl });
                // Auto-clear after 2 minutes if no reply
                setTimeout(() => pendingTT.delete(from), 120000);
                await reply('📥 What format do you want?\n\nReply *mp4* for video 🎬\nReply *mp3* for audio 🎵');
            } catch (e) {
                console.error('TikTok error:', e);
                reply('❌ Failed to fetch TikTok video.');
            }
        }

        if (cmd === 'mp4' && pendingTT.has(from)) {
            const { videoUrl } = pendingTT.get(from);
            pendingTT.delete(from);
            await reply('⏳ Sending video... please wait');
            try {
                const tmpFile = path.join(os.tmpdir(), `wa_tt_${Date.now()}.mp4`);
                await downloadUrlToFile(videoUrl, tmpFile);
                await sendVideo(tmpFile, sock, from, msg, reply);
            } catch (e) {
                console.error('TikTok mp4 send error:', e);
                reply('❌ Failed to send the video.');
            }
        }

        if (cmd === 'mp3' && pendingTT.has(from)) {
            const { audioUrl } = pendingTT.get(from);
            pendingTT.delete(from);
            await reply('⏳ Extracting audio... please wait');
            try {
                const tmpVideo = path.join(os.tmpdir(), `wa_tt_${Date.now()}_src.mp4`);
                const tmpAudio = tmpVideo.replace('_src.mp4', '.mp3');
                await downloadUrlToFile(audioUrl, tmpVideo);
                await new Promise((resolve, reject) => {
                    exec(`ffmpeg -i "${tmpVideo}" -q:a 0 -map a "${tmpAudio}" -y`, { timeout: 60000 }, (err) => {
                        try { fs.unlinkSync(tmpVideo); } catch (e) {}
                        if (err) reject(err); else resolve();
                    });
                });
                const buffer = fs.readFileSync(tmpAudio);
                await sock.sendMessage(from, { audio: buffer, mimetype: 'audio/mpeg', ptt: false }, { quoted: msg });
                try { fs.unlinkSync(tmpAudio); } catch (e) {}
            } catch (e) {
                console.error('TikTok mp3 error:', e);
                reply('❌ Failed to extract audio.');
            }
        }

        if (text.trim().toLowerCase().startsWith('.video')) {
            // Extract YouTube URL from message using regex (handles <url>, plain url, etc.)
            const urlMatch = text.match(/(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[\w\-?=&]+)/i);
            if (!urlMatch) return reply('❌ Please send a valid YouTube link.\nExample: .video https://youtu.be/xxxxx');

            const url = urlMatch[1];
            await reply('⏳ Downloading video... please wait');

            const tmpFile = path.join(os.tmpdir(), `wa_video_${Date.now()}.mp4`);

            // android client reliably returns format 18 (360p MP4) without needing tokens
            // fallback: ios,mweb uses HLS streams
            const tryDownload = (extraArgs, cb) => {
                const command = `yt-dlp ${extraArgs} --merge-output-format mp4 -o "${tmpFile}" --no-playlist "${url}"`;
                exec(command, { timeout: 120000 }, cb);
            };

            tryDownload(
                `--extractor-args "youtube:player_client=android" -f "18/best[height<=480][ext=mp4]/best[height<=480]"`,
                async (err, stdout, stderr) => {
                    if (err) {
                        console.error('android failed, trying ios+mweb:', stderr);
                        // Fallback to ios+mweb HLS
                        tryDownload(
                            `--extractor-args "youtube:player_client=ios,mweb" --format-sort "res:480,ext:mp4"`,
                            async (err2, stdout2, stderr2) => {
                                if (err2) {
                                    console.error('ios+mweb also failed:', stderr2);
                                    return reply('❌ Could not download this video. It may be age-restricted or unavailable.');
                                }
                                await sendVideo(tmpFile, sock, from, msg, reply);
                            }
                        );
                        return;
                    }
                    await sendVideo(tmpFile, sock, from, msg, reply);
                }
            );
        }
    });
}

startBot();
