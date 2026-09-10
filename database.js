const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, 'database.sqlite');

class DatabaseService {
  constructor() {
    this.db = null;
    this.SQL = null;
  }

  async init() {
    this.SQL = await initSqlJs();

    if (fs.existsSync(DB_PATH)) {
      try {
        const fileBuffer = fs.readFileSync(DB_PATH);
        this.db = new this.SQL.Database(fileBuffer);
        console.log('📦 Loaded existing SQLite database from database.sqlite');
      } catch (err) {
        console.warn('⚠️ Could not load existing SQLite file, creating fresh database:', err.message);
        this.db = new this.SQL.Database();
      }
    } else {
      this.db = new this.SQL.Database();
      console.log('✨ Created new SQLite database in database.sqlite');
    }

    this.createTables();
    this.seedDefaultChannels();
    this.save();
    return this;
  }

  save() {
    if (!this.db) return;
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(DB_PATH, buffer);
    } catch (err) {
      console.error('❌ Failed to save SQLite database:', err.message);
    }
  }

  createTables() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        password_hash TEXT,
        avatar_color TEXT,
        avatar_url TEXT,
        bio TEXT,
        status TEXT DEFAULT 'online',
        is_guest INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        icon TEXT,
        is_private INTEGER DEFAULT 0,
        created_by TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_members (
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        room_type TEXT NOT NULL,
        room_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        recipient_id TEXT,
        content TEXT NOT NULL,
        message_type TEXT DEFAULT 'text',
        file_url TEXT,
        file_name TEXT,
        file_size INTEGER,
        reply_to_id TEXT,
        reply_to_sender TEXT,
        reply_to_content TEXT,
        is_edited INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reactions (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (message_id, user_id, emoji)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(message_id);
    `);
  }

  seedDefaultChannels() {
    const defaults = [
      { id: 'chan_general', name: 'general', description: 'The town square - hang out, chat and say hello!', icon: '💬' },
      { id: 'chan_random', name: 'random', description: 'Memes, casual banter, fun links & laughs', icon: '⚡' },
      { id: 'chan_tech', name: 'tech-lounge', description: 'Coding, apps, hardware, and tech ideas', icon: '🚀' },
      { id: 'chan_media', name: 'music-and-media', description: 'Share clips, voice notes, tracks, and art', icon: '🎧' }
    ];

    for (const c of defaults) {
      const stmt = this.db.prepare('SELECT id FROM channels WHERE id = :id OR name = :name');
      stmt.bind({ ':id': c.id, ':name': c.name });
      const exists = stmt.step();
      stmt.free();

      if (!exists) {
        this.run(
          'INSERT INTO channels (id, name, description, icon, is_private, created_by, created_at) VALUES (?, ?, ?, ?, 0, "system", ?)',
          [c.id, c.name, c.description, c.icon, Date.now()]
        );
      }
    }
  }

  // --- Helper SQL execution ---
  run(sql, params = []) {
    this.db.run(sql, params);
    this.save();
  }

  getOne(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    let row = null;
    if (stmt.step()) {
      row = stmt.getAsObject();
    }
    stmt.free();
    return row;
  }

  getAll(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  // --- User Queries ---
  getUserById(id) {
    return this.getOne('SELECT id, username, display_name, avatar_color, avatar_url, bio, status, is_guest, created_at, last_seen FROM users WHERE id = ?', [id]);
  }

  getUserWithPassword(username) {
    return this.getOne('SELECT * FROM users WHERE LOWER(username) = LOWER(?)', [username]);
  }

  getUserByUsername(username) {
    return this.getOne('SELECT id, username, display_name, avatar_color, avatar_url, bio, status, is_guest, created_at, last_seen FROM users WHERE LOWER(username) = LOWER(?)', [username]);
  }

  createUser({ id, username, display_name, password_hash, avatar_color, avatar_url, bio, is_guest = 0 }) {
    const now = Date.now();
    this.run(
      `INSERT INTO users (id, username, display_name, password_hash, avatar_color, avatar_url, bio, status, is_guest, created_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'online', ?, ?, ?)`,
      [id, username, display_name, password_hash || null, avatar_color || '#6366f1', avatar_url || null, bio || '', is_guest ? 1 : 0, now, now]
    );
    return this.getUserById(id);
  }

  updateUserStatus(id, status) {
    const now = Date.now();
    this.run('UPDATE users SET status = ?, last_seen = ? WHERE id = ?', [status, now, id]);
  }

  updateUserProfile(id, { display_name, bio, avatar_color, avatar_url }) {
    this.run(
      'UPDATE users SET display_name = COALESCE(?, display_name), bio = COALESCE(?, bio), avatar_color = COALESCE(?, avatar_color), avatar_url = COALESCE(?, avatar_url) WHERE id = ?',
      [display_name, bio, avatar_color, avatar_url, id]
    );
    return this.getUserById(id);
  }

  getAllUsers() {
    return this.getAll('SELECT id, username, display_name, avatar_color, avatar_url, bio, status, is_guest, created_at, last_seen FROM users ORDER BY last_seen DESC');
  }

  // --- Channel Queries ---
  getChannels() {
    return this.getAll('SELECT * FROM channels ORDER BY created_at ASC');
  }

  getChannelById(id) {
    return this.getOne('SELECT * FROM channels WHERE id = ?', [id]);
  }

  createChannel({ id, name, description, icon, is_private = 0, created_by }) {
    const cleanName = name.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    const now = Date.now();
    this.run(
      'INSERT INTO channels (id, name, description, icon, is_private, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, cleanName, description || '', icon || '💬', is_private ? 1 : 0, created_by, now]
    );
    return this.getChannelById(id);
  }

  // --- Message Queries ---
  saveMessage(msg) {
    this.run(
      `INSERT INTO messages (id, room_type, room_id, sender_id, recipient_id, content, message_type, file_url, file_name, file_size, reply_to_id, reply_to_sender, reply_to_content, is_edited, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        msg.id,
        msg.room_type,
        msg.room_id,
        msg.sender_id,
        msg.recipient_id || null,
        msg.content,
        msg.message_type || 'text',
        msg.file_url || null,
        msg.file_name || null,
        msg.file_size || 0,
        msg.reply_to_id || null,
        msg.reply_to_sender || null,
        msg.reply_to_content || null,
        msg.created_at || Date.now()
      ]
    );
    return this.getMessageWithSender(msg.id);
  }

  getMessageWithSender(id) {
    const msg = this.getOne(`
      SELECT m.*, u.username as sender_username, u.display_name as sender_display_name, u.avatar_color as sender_avatar_color, u.avatar_url as sender_avatar_url
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.id = ?
    `, [id]);
    if (msg) {
      msg.reactions = this.getReactionsForMessage(id);
    }
    return msg;
  }

  getMessages(roomId, limit = 50, beforeTimestamp = null) {
    let sql = `
      SELECT m.*, u.username as sender_username, u.display_name as sender_display_name, u.avatar_color as sender_avatar_color, u.avatar_url as sender_avatar_url
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.room_id = ?
    `;
    const params = [roomId];

    if (beforeTimestamp) {
      sql += ' AND m.created_at < ?';
      params.push(beforeTimestamp);
    }

    sql += ' ORDER BY m.created_at DESC LIMIT ?';
    params.push(limit);

    const rows = this.getAll(sql, params).reverse();
    
    // Attach reactions
    for (const row of rows) {
      row.reactions = this.getReactionsForMessage(row.id);
    }
    return rows;
  }

  deleteMessage(messageId, userId) {
    const msg = this.getOne('SELECT * FROM messages WHERE id = ?', [messageId]);
    if (!msg) return null;
    if (msg.sender_id !== userId) return false;

    this.run('DELETE FROM reactions WHERE message_id = ?', [messageId]);
    this.run('DELETE FROM messages WHERE id = ?', [messageId]);
    return true;
  }

  editMessage(messageId, userId, newContent) {
    const msg = this.getOne('SELECT * FROM messages WHERE id = ?', [messageId]);
    if (!msg) return null;
    if (msg.sender_id !== userId) return false;

    this.run('UPDATE messages SET content = ?, is_edited = 1 WHERE id = ?', [newContent, messageId]);
    return this.getMessageWithSender(messageId);
  }

  searchMessages(query, roomId = null) {
    let sql = `
      SELECT m.*, u.username as sender_username, u.display_name as sender_display_name, u.avatar_color as sender_avatar_color
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.content LIKE ?
    `;
    const params = [`%${query}%`];
    if (roomId) {
      sql += ' AND m.room_id = ?';
      params.push(roomId);
    }
    sql += ' ORDER BY m.created_at DESC LIMIT 30';
    return this.getAll(sql, params);
  }

  // --- Reactions ---
  addReaction({ id, message_id, user_id, username, emoji }) {
    try {
      this.run(
        'INSERT OR REPLACE INTO reactions (id, message_id, user_id, username, emoji, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, message_id, user_id, username, emoji, Date.now()]
      );
      return this.getReactionsForMessage(message_id);
    } catch (err) {
      return this.getReactionsForMessage(message_id);
    }
  }

  removeReaction(messageId, userId, emoji) {
    this.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [messageId, userId, emoji]);
    return this.getReactionsForMessage(messageId);
  }

  getReactionsForMessage(messageId) {
    const rows = this.getAll('SELECT emoji, user_id, username FROM reactions WHERE message_id = ?', [messageId]);
    const grouped = {};
    for (const r of rows) {
      if (!grouped[r.emoji]) {
        grouped[r.emoji] = { emoji: r.emoji, count: 0, users: [] };
      }
      grouped[r.emoji].count++;
      grouped[r.emoji].users.push({ id: r.user_id, username: r.username });
    }
    return Object.values(grouped);
  }

  getDirectMessageRooms(userId) {
    const sql = `
      SELECT DISTINCT 
        CASE 
          WHEN sender_id = ? THEN recipient_id 
          ELSE sender_id 
        END as partner_id,
        room_id,
        MAX(created_at) as last_activity
      FROM messages
      WHERE room_type = 'direct' AND (sender_id = ? OR recipient_id = ?)
      GROUP BY partner_id, room_id
      ORDER BY last_activity DESC
    `;
    const rooms = this.getAll(sql, [userId, userId, userId]);
    return rooms.map(r => {
      const partner = this.getUserById(r.partner_id);
      return {
        room_id: r.room_id,
        partner: partner || { id: r.partner_id, username: 'Unknown User', status: 'offline' },
        last_activity: r.last_activity
      };
    });
  }

  getStats() {
    const userCount = this.getOne('SELECT COUNT(*) as count FROM users')?.count || 0;
    const msgCount = this.getOne('SELECT COUNT(*) as count FROM messages')?.count || 0;
    const chanCount = this.getOne('SELECT COUNT(*) as count FROM channels')?.count || 0;
    let dbSize = 0;
    if (fs.existsSync(DB_PATH)) {
      dbSize = fs.statSync(DB_PATH).size;
    }
    return {
      users: userCount,
      messages: msgCount,
      channels: chanCount,
      db_size_kb: Math.round(dbSize / 1024)
    };
  }
}

const dbService = new DatabaseService();
module.exports = dbService;
