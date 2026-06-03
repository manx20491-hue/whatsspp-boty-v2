# 🤖 X BOT — WhatsApp Bot

Built with Baileys. Supports YouTube, TikTok, Instagram, Facebook downloads + Islamic greeting.

## 📦 Requirements

- Node.js 20+
- yt-dlp (system tool)
- ffmpeg (system tool)

### Install yt-dlp & ffmpeg

**Linux/VPS:**
```
sudo apt install ffmpeg -y
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod +x /usr/local/bin/yt-dlp
```

## 🚀 Setup

```
npm install
npm start
```

Then open `http://localhost:5000` in your browser and scan the QR code with WhatsApp.

## 💬 Commands

| Command | Description |
|---|---|
| `As salamu alaykum` | Islamic greeting reply |
| `menu` | Show all commands with photo |
| `ping` | Check bot response |
| `.video <YouTube link>` | Download YouTube video (MP4) |
| `.song <YouTube link>` | Download YouTube audio (MP3) |
| `.insta <Instagram link>` | Download Instagram video |
| `.fb <Facebook link>` | Download Facebook video |
| `.tt <TikTok link>` | Download TikTok (choose MP4 or MP3) |

## 📁 Files

- `index.js` — Main bot code
- `package.json` — Dependencies
- `menu.png` — Menu photo (shown with `menu` command)
- `start.sh` — Easy start script
