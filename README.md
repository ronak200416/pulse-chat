# ⚡ Pulse Chat — Real-Time Cross-Platform Messaging

An ultra-fast, cross-platform real-time messaging web application powered by **Node.js**, **Socket.IO**, and **SQLite**. Built to run directly from your PC as a live server with seamless phone & desktop connectivity, local Wi-Fi QR code onboarding, worldwide public tunneling, and 24/7 cloud hosting compatibility.

---

## 🌟 Key Features

- **⚡ Sub-Millisecond Real-Time Messaging**: Powered by Socket.IO with bidirectional WebSocket communication.
- **💾 SQLite Persistence**: Ultra-fast, zero-configuration database storing users, channels, direct messages, attachments, and emoji reactions in `database.sqlite`.
- **📱 True Cross-Platform Design**: Responsive modern glassmorphic interface that looks and feels like a native mobile app on phones and an expansive workspace on desktops.
- **💬 Channels & 1-on-1 Direct Messaging**: Public group channels (`#general`, `#random`, `#tech-lounge`, `#music-and-media`) + private 1-on-1 DMs.
- **🎙️ Voice Notes Recording**: Record audio messages directly in browser with live duration timers and waveform playback.
- **🖼️ Media & File Sharing**: Instant image previews, lightbox modal viewer, and file attachments.
- **✨ Rich Interactions**: Real-time typing indicators, emoji reactions (`❤️`, `👍`, `😂`, `🔥`, etc.), message replies/quoting, editing, and deletion.
- **🔍 Message Search**: Instant search across conversations with highlights.
- **🔊 Web Audio Chimes**: Smooth synthesized audio notifications for incoming and outgoing messages (no missing audio assets).
- **📲 Mobile Connection Hub**: Instant QR code generator for scanning with your smartphone camera on local Wi-Fi.
- **🌍 Global Public Tunneling**: Built-in 1-command public HTTPS tunnel so anyone across the world can join your chat server.

---

## 🚀 Quick Start (Running on your PC)

### 1. Start the Server
Open your terminal in this directory and run:
```bash
npm start
```
The server will start on port `3000` and output:
- **Local Address**: `http://localhost:3000`
- **Wi-Fi LAN Address**: `http://192.168.x.x:3000` (e.g. `http://192.168.1.159:3000`)

### 2. Connect Your Phone via Wi-Fi (QR Code)
1. Open `http://localhost:3000` on your PC.
2. Click **"📱 Connect Phone / Share"** in the sidebar.
3. Open your phone's camera, scan the QR code, and tap the link!
4. You and your phone are now connected in real-time to your PC's SQLite database!

---

## 🌍 Connecting Anyone Across the World (Live from your PC)

While your server is running, open a second terminal tab and run:
```bash
npm run tunnel
```
This automatically spins up a secure public HTTPS link (e.g. `https://cool-chat-room.loca.lt`) and prints a terminal QR code. Send this link to anyone in the world to chat with you in real time!

---

## ☁️ Hosting 24/7 in the Cloud (Free & Easy)

When you're ready to make your chat app live 24/7 without keeping your PC powered on:

### Option A: Deploy to Render.com (Recommended for Node.js + WebSockets + SQLite)
1. Push your project to a GitHub repository:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/your-username/pulse-chat.git
   git push -u origin main
   ```
2. Go to [Render.com](https://render.com) and click **New > Web Service**.
3. Connect your GitHub repository.
4. Set:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. Click **Create Web Service**. Your chat app is now live 24/7 with free HTTPS!

### Option B: Deploy to Railway.app or Fly.io
- **Railway**: Click *New Project* > *Deploy from GitHub repo*. Railway automatically detects Node.js and assigns an active HTTPS domain with persistent disk options.
- **Fly.io**: Run `fly launch` and `fly deploy`.

### Option C: Deploy to Vercel
For serverless hosting on Vercel:
1. Connect SQLite cloud database via [Turso](https://turso.tech) (`@libsql/client`) or Supabase.
2. Deploy directly via `vercel deploy`.

---

## 📂 Project Structure

```
├── database.js          # SQLite database engine (sql.js) & schema management
├── server.js            # Express REST API & Socket.IO real-time server
├── tunnel.js            # 1-click worldwide public tunnel script
├── database.sqlite      # SQLite database file (created automatically)
├── uploads/             # Media and voice note storage
├── package.json         # Project dependencies and scripts
└── public/              # Client web app
    ├── index.html       # Responsive HTML5 markup & modals
    ├── css/
    │   └── style.css    # Modern glassmorphism dark theme styling
    └── js/
        ├── app.js       # Client coordinator & Web Audio chimes
        ├── auth.js      # Guest onboarding & login/register state
        ├── chat.js      # Message rendering, markdown, voice recording & reactions
        └── network-modal.js # QR code & LAN address generation
```

---

## 🔒 Security & Privacy
- Passwords hashed using `bcryptjs` with salt rounds.
- REST endpoints and WebSocket handshakes secured with signed JWT tokens.
- SQL queries parameterized to protect against SQL injection.
- Multer file uploads bounded by size limits (25MB).
