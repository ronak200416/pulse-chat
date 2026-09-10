const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const db = require('./database');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'pulse_chat_secret_key_super_secure_2026';

// Ensure uploads directory exists
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Setup Multer for file / voice / image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}${ext}`;
    cb(null, uniqueName);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB max
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'DELETE']
  },
  maxHttpBufferSize: 1e7 // 10MB
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// Helper: Get local LAN IP address
function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

// Authentication Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

function optionalToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (!err) req.user = user;
      next();
    });
  } else {
    next();
  }
}

// --- REST API ENDPOINTS ---

// 1. Auth: Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, display_name, password, avatar_color, bio } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const cleanUsername = username.trim().toLowerCase();
    if (cleanUsername.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }

    const existing = db.getUserByUsername(cleanUsername);
    if (existing) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const userId = `usr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const colors = ['#6366f1', '#ec4899', '#8b5cf6', '#10b981', '#f59e0b', '#06b6d4', '#3b82f6'];
    const chosenColor = avatar_color || colors[Math.floor(Math.random() * colors.length)];

    const user = db.createUser({
      id: userId,
      username: cleanUsername,
      display_name: display_name ? display_name.trim() : cleanUsername,
      password_hash,
      avatar_color: chosenColor,
      bio: bio ? bio.trim() : '',
      is_guest: 0
    });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Server error during registration' });
  }
});

// 2. Auth: Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const cleanUsername = username.trim().toLowerCase();
    const user = db.getUserWithPassword(cleanUsername);
    if (!user || !user.password_hash) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    const safeUser = db.getUserById(user.id);
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// 3. Auth: Quick Guest Mode
app.post('/api/auth/guest', (req, res) => {
  try {
    let { display_name, avatar_color } = req.body;
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const cleanUsername = `guest_${randomSuffix}`;
    
    const colors = ['#6366f1', '#ec4899', '#8b5cf6', '#10b981', '#f59e0b', '#06b6d4', '#3b82f6'];
    const chosenColor = avatar_color || colors[Math.floor(Math.random() * colors.length)];
    const userId = `guest_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const user = db.createUser({
      id: userId,
      username: cleanUsername,
      display_name: display_name ? display_name.trim() : `Guest ${randomSuffix}`,
      avatar_color: chosenColor,
      bio: 'Visiting as a guest 🌟',
      is_guest: 1
    });

    const token = jwt.sign({ id: user.id, username: user.username, is_guest: true }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (err) {
    console.error('Guest login error:', err);
    res.status(500).json({ error: 'Server error during guest creation' });
  }
});

// 4. Auth: Get Current Profile
app.get('/api/auth/me', authenticateToken, (req, res) => {
  const user = db.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// 5. Update Profile
app.put('/api/users/profile', authenticateToken, (req, res) => {
  try {
    const { display_name, bio, avatar_color, avatar_url } = req.body;
    const updated = db.updateUserProfile(req.user.id, { display_name, bio, avatar_color, avatar_url });
    io.emit('user_profile_updated', updated);
    res.json({ user: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// 6. Get All Users
app.get('/api/users', (req, res) => {
  const users = db.getAllUsers();
  res.json({ users });
});

// 7. Get Channels
app.get('/api/channels', optionalToken, (req, res) => {
  const userId = req.user ? req.user.id : null;
  const channels = db.getChannels(userId);
  res.json({ channels });
});

// 8. Create Channel / Group with Member Selection
app.post('/api/channels', authenticateToken, (req, res) => {
  try {
    const { name, description, icon, is_private, members } = req.body;
    if (!name || name.trim().length < 2) {
      return res.status(400).json({ error: 'Channel name is required (min 2 chars)' });
    }

    const chanId = `chan_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const channel = db.createChannel({
      id: chanId,
      name: name.trim(),
      description: description ? description.trim() : '',
      icon: icon || '💬',
      is_private: is_private ? 1 : 0,
      created_by: req.user.id,
      members: members || []
    });

    io.emit('channel_created', channel);
    res.json({ channel });
  } catch (err) {
    console.error('Create channel error:', err);
    res.status(400).json({ error: 'Channel creation failed. Name may already exist.' });
  }
});

// 9. Delete Channel / Group (Only by creator)
app.delete('/api/channels/:id', authenticateToken, (req, res) => {
  try {
    const result = db.deleteChannel(req.params.id, req.user.id);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    io.emit('channel_deleted', { channelId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete channel error:', err);
    res.status(500).json({ error: 'Failed to delete channel' });
  }
});

// 10. Leave Channel / Group (By member)
app.post('/api/channels/:id/leave', authenticateToken, (req, res) => {
  try {
    const result = db.leaveChannel(req.params.id, req.user.id);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    io.emit('member_left', { channelId: req.params.id, userId: req.user.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to leave channel' });
  }
});

// 11. Remove Member from Group (Only by Creator)
app.delete('/api/channels/:channelId/members/:userId', authenticateToken, (req, res) => {
  try {
    const result = db.removeChannelMember(req.params.channelId, req.params.userId, req.user.id);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    io.emit('member_removed', { channelId: req.params.channelId, userId: req.params.userId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// 12. Get Channel Members
app.get('/api/channels/:id/members', (req, res) => {
  const members = db.getChannelMembers(req.params.id);
  res.json({ members });
});

// 12. Get Room Messages
app.get('/api/messages/:roomId', (req, res) => {
  const { roomId } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  const before = req.query.before ? parseInt(req.query.before) : null;
  const messages = db.getMessages(roomId, limit, before);
  res.json({ messages });
});

// 13. File & Audio Note Upload
app.post('/api/upload', authenticateToken, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({
    url: fileUrl,
    filename: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype
  });
});

// 14. Search Messages
app.get('/api/messages-search', (req, res) => {
  const query = req.query.q || '';
  const roomId = req.query.roomId || null;
  if (!query.trim()) return res.json({ messages: [] });
  const messages = db.searchMessages(query, roomId);
  res.json({ messages });
});

// 15. Direct Message Conversations
app.get('/api/dms', authenticateToken, (req, res) => {
  const dms = db.getDirectMessageRooms(req.user.id);
  res.json({ dms });
});

// 16. Server Stats
app.get('/api/network-info', (req, res) => {
  try {
    const lanIp = getLanIp();
    const stats = db.getStats();

    res.json({
      port: PORT,
      lanIp,
      localUrl: `http://localhost:${PORT}`,
      stats,
      uptime: process.uptime()
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get server info' });
  }
});

// --- REAL-TIME SOCKET.IO ENGINE ---

const onlineUsers = new Map();
const userSocketMap = new Map();

io.on('connection', (socket) => {
  let currentUser = null;

  // Authenticate socket
  socket.on('authenticate', (token) => {
    if (!token) return;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      currentUser = db.getUserById(decoded.id);
      if (!currentUser) return;

      onlineUsers.set(socket.id, currentUser.id);

      if (!userSocketMap.has(currentUser.id)) {
        userSocketMap.set(currentUser.id, new Set());
      }
      userSocketMap.get(currentUser.id).add(socket.id);

      db.updateUserStatus(currentUser.id, 'online');
      socket.broadcast.emit('user_presence', {
        userId: currentUser.id,
        status: 'online',
        last_seen: Date.now()
      });

      const activeIds = Array.from(userSocketMap.keys());
      socket.emit('online_users_list', activeIds);
    } catch (err) {
      console.warn('Socket auth failed:', err.message);
    }
  });

  // Join Room
  socket.on('join_room', (roomId) => {
    socket.join(roomId);
  });

  // Leave Room
  socket.on('leave_room', (roomId) => {
    socket.leave(roomId);
  });

  // Send Message
  socket.on('send_message', (msgData, callback) => {
    try {
      if (!currentUser && msgData.sender_id) {
        currentUser = db.getUserById(msgData.sender_id);
      }
      if (!currentUser) {
        if (callback) callback({ error: 'Unauthorized' });
        return;
      }

      const msgId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const newMsg = db.saveMessage({
        id: msgId,
        room_type: msgData.room_type || 'channel',
        room_id: msgData.room_id,
        sender_id: currentUser.id,
        recipient_id: msgData.recipient_id || null,
        content: msgData.content || '',
        message_type: msgData.message_type || 'text',
        file_url: msgData.file_url || null,
        file_name: msgData.file_name || null,
        file_size: msgData.file_size || 0,
        reply_to_id: msgData.reply_to_id || null,
        reply_to_sender: msgData.reply_to_sender || null,
        reply_to_content: msgData.reply_to_content || null,
        created_at: Date.now()
      });

      io.to(msgData.room_id).emit('new_message', newMsg);

      if (msgData.room_type === 'direct' && msgData.recipient_id) {
        const recipientSockets = userSocketMap.get(msgData.recipient_id);
        if (recipientSockets) {
          for (const sId of recipientSockets) {
            io.to(sId).emit('dm_notification', newMsg);
          }
        }
      }

      if (callback) callback({ success: true, message: newMsg });
    } catch (err) {
      console.error('Socket send_message error:', err);
      if (callback) callback({ error: 'Failed to send message' });
    }
  });

  // Typing
  socket.on('typing', ({ roomId, username }) => {
    socket.to(roomId).emit('user_typing', { roomId, username });
  });

  socket.on('stop_typing', ({ roomId, username }) => {
    socket.to(roomId).emit('user_stop_typing', { roomId, username });
  });

  // Reactions
  socket.on('add_reaction', ({ messageId, emoji, roomId }) => {
    if (!currentUser) return;
    const reactionId = `rx_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const updatedReactions = db.addReaction({
      id: reactionId,
      message_id: messageId,
      user_id: currentUser.id,
      username: currentUser.display_name || currentUser.username,
      emoji
    });
    io.to(roomId).emit('reaction_updated', { messageId, reactions: updatedReactions });
  });

  socket.on('remove_reaction', ({ messageId, emoji, roomId }) => {
    if (!currentUser) return;
    const updatedReactions = db.removeReaction(messageId, currentUser.id, emoji);
    io.to(roomId).emit('reaction_updated', { messageId, reactions: updatedReactions });
  });

  // Delete Message
  socket.on('delete_message', ({ messageId, roomId }, callback) => {
    if (!currentUser) return;
    const ok = db.deleteMessage(messageId, currentUser.id);
    if (ok) {
      io.to(roomId).emit('message_deleted', { messageId, roomId });
      if (callback) callback({ success: true });
    } else {
      if (callback) callback({ error: 'Permission denied or message not found' });
    }
  });

  // Edit Message
  socket.on('edit_message', ({ messageId, newContent, roomId }, callback) => {
    if (!currentUser) return;
    const updated = db.editMessage(messageId, currentUser.id, newContent);
    if (updated) {
      io.to(roomId).emit('message_edited', { message: updated, roomId });
      if (callback) callback({ success: true, message: updated });
    } else {
      if (callback) callback({ error: 'Permission denied' });
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    const uId = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);

    if (uId && userSocketMap.has(uId)) {
      const userSockets = userSocketMap.get(uId);
      userSockets.delete(socket.id);
      if (userSockets.size === 0) {
        userSocketMap.delete(uId);
        db.updateUserStatus(uId, 'offline');
        io.emit('user_presence', { userId: uId, status: 'offline', last_seen: Date.now() });
      }
    }
  });
});

async function startServer() {
  await db.init();

  server.listen(PORT, '0.0.0.0', () => {
    const lanIp = getLanIp();
    console.log('\n==================================================');
    console.log('⚡  PULSE CHAT SERVER IS LIVE!  ⚡');
    console.log('==================================================');
    console.log(`🏠 Local URL:         http://localhost:${PORT}`);
    console.log(`📱 LAN / Mobile:      http://${lanIp}:${PORT}`);
    console.log('💾 SQLite Database:   database.sqlite');
    console.log('==================================================\n');
  });
}

process.on('SIGINT', () => {
  db.save();
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.save();
  process.exit(0);
});

startServer().catch(err => {
  console.error('Failed to start server:', err);
});
