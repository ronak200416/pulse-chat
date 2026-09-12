require('dotenv').config();
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { createClient } = require('@libsql/client');

const DB_PATH = path.join(__dirname, 'database.sqlite');

function findEnvValue(patternRegex) {
  for (const [key, value] of Object.entries(process.env)) {
    const cleanKey = key.trim();
    if (patternRegex.test(cleanKey) && value && value.trim()) {
      return value.trim().replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

function getTursoCredentials() {
  // 1. Direct match or case-insensitive search for URL
  let url = (process.env.TURSO_DATABASE_URL || process.env.TURSO_URL || '').trim().replace(/^["']|["']$/g, '');
  if (!url) {
    url = findEnvValue(/^(turso[_-]?(database[_-]?)?url|turso[_-]?db[_-]?url|turso[_-]?uri|database[_-]?url)$/i);
  }
  if (!url) {
    url = findEnvValue(/turso.*url|url.*turso|libsql/i);
  }
  // Auto-detect if any env variable value contains a Turso URL
  if (!url) {
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string' && (v.startsWith('libsql://') || v.includes('.turso.io'))) {
        url = v.trim().replace(/^["']|["']$/g, '');
        break;
      }
    }
  }

  // 2. Direct match or case-insensitive search for Token
  let token = (process.env.TURSO_AUTH_TOKEN || process.env.TURSO_TOKEN || '').trim().replace(/^["']|["']$/g, '');
  if (!token) {
    token = findEnvValue(/^(turso[_-]?(auth[_-]?)?token|turso[_-]?auth|auth[_-]?token)$/i);
  }
  if (!token) {
    token = findEnvValue(/turso.*token|token.*turso/i);
  }
  // Auto-detect if any env variable value contains the JWT auth token
  if (!token) {
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string' && v.startsWith('eyJ') && v.length > 50 && k !== 'JWT_SECRET') {
        token = v.trim().replace(/^["']|["']$/g, '');
        break;
      }
    }
  }

  return { url, token, isConfigured: Boolean(url && token) };
}

class DatabaseService {
  constructor() {
    this.isTurso = false;
    this.tursoClient = null;
    this.db = null; // Local sql.js
    this.SQL = null;
    this.tursoError = null;
  }

  async init() {
    const { url, token, isConfigured } = getTursoCredentials();

    if (isConfigured) {
      try {
        console.log(`⚡ Connecting to Turso Cloud SQLite database at ${url}...`);
        this.tursoClient = createClient({
          url,
          authToken: token
        });
        this.isTurso = true;
        await this.createTablesTurso();
        await this.cleanupLegacyChannelsTurso();
        await this.seedDefaultChannelsTurso();
        try {
          await this.run("DELETE FROM messages WHERE content LIKE '%Anonymous check%'");
        } catch (e) {}
        console.log('🌟 Connected to Turso Cloud SQLite with 100% PERMANENT cloud storage!');
        return this;
      } catch (err) {
        console.error('❌ Failed to connect to Turso Cloud SQLite:', err.message);
        this.tursoError = err.message;
        this.isTurso = false;
        this.tursoClient = null;
        console.log('⚠️ Falling back to Local SQLite database...');
      }
    } else {
      if (url || token) {
        console.warn(`⚠️ Incomplete Turso credentials: URL=${url ? 'present' : 'missing'}, Token=${token ? 'present' : 'missing'}`);
        this.tursoError = `Incomplete credentials: URL is ${url ? 'present' : 'missing'}, Token is ${token ? 'present' : 'missing'}`;
      }
    }

    // Local SQLite fallback
    this.SQL = await initSqlJs();

    if (fs.existsSync(DB_PATH)) {
      try {
        const fileBuffer = fs.readFileSync(DB_PATH);
        this.db = new this.SQL.Database(fileBuffer);
        console.log('📦 Loaded existing local SQLite database from database.sqlite');
      } catch (err) {
        console.warn('⚠️ Creating fresh local database:', err.message);
        this.db = new this.SQL.Database();
      }
    } else {
      this.db = new this.SQL.Database();
      console.log('✨ Created new local SQLite database in database.sqlite');
    }

    this.createTablesLocal();
    this.cleanupLegacyChannelsLocal();
    this.seedDefaultChannelsLocal();
    try {
      this.db.run("DELETE FROM messages WHERE content LIKE '%Anonymous check%'");
    } catch (e) {}
    this.saveLocal();
    return this;
  }

  saveLocal() {
    if (this.isTurso || !this.db) return;
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(DB_PATH, buffer);
    } catch (err) {
      console.error('❌ Failed to save SQLite database:', err.message);
    }
  }

  // --- TURSO SCHEMA & SEED ---
  async createTablesTurso() {
    await this.tursoClient.executeMultiple(`
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

      CREATE TABLE IF NOT EXISTS friend_requests (
        id TEXT PRIMARY KEY,
        sender_id TEXT NOT NULL,
        receiver_id TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (sender_id, receiver_id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(message_id);
      CREATE INDEX IF NOT EXISTS idx_fr_receiver ON friend_requests(receiver_id, status);
      CREATE INDEX IF NOT EXISTS idx_fr_sender ON friend_requests(sender_id, status);
    `);
  }

  async cleanupLegacyChannelsTurso() {
    const legacyIds = ['chan_random', 'chan_tech', 'chan_media'];
    for (const id of legacyIds) {
      const messages = await this.getAll('SELECT id FROM messages WHERE room_id = ?', [id]);
      for (const m of messages) {
        await this.run('DELETE FROM reactions WHERE message_id = ?', [m.id]);
      }
      await this.run('DELETE FROM messages WHERE room_id = ?', [id]);
      await this.run('DELETE FROM channel_members WHERE channel_id = ?', [id]);
      await this.run('DELETE FROM channels WHERE id = ?', [id]);
    }
  }

  async seedDefaultChannelsTurso() {
    const defaults = [
      { id: 'chan_general', name: 'General', description: 'The town square - hang out, chat and say hello to everyone!', icon: '💬' }
    ];

    for (const c of defaults) {
      await this.tursoClient.execute({
        sql: 'INSERT OR IGNORE INTO channels (id, name, description, icon, is_private, created_by, created_at) VALUES (?, ?, ?, ?, 0, "system", ?)',
        args: [c.id, c.name, c.description, c.icon, Date.now()]
      });
      await this.tursoClient.execute({
        sql: 'UPDATE channels SET name = "General" WHERE id = "chan_general"',
        args: []
      });
    }
  }

  // --- LOCAL SCHEMA & SEED ---
  createTablesLocal() {
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

      CREATE TABLE IF NOT EXISTS friend_requests (
        id TEXT PRIMARY KEY,
        sender_id TEXT NOT NULL,
        receiver_id TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (sender_id, receiver_id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(message_id);
      CREATE INDEX IF NOT EXISTS idx_fr_receiver ON friend_requests(receiver_id, status);
      CREATE INDEX IF NOT EXISTS idx_fr_sender ON friend_requests(sender_id, status);
    `);
  }

  cleanupLegacyChannelsLocal() {
    const legacyIds = ['chan_random', 'chan_tech', 'chan_media'];
    for (const id of legacyIds) {
      try {
        const stmt = this.db.prepare('SELECT id FROM messages WHERE room_id = :id');
        stmt.bind({ ':id': id });
        const msgIds = [];
        while (stmt.step()) {
          msgIds.push(stmt.getAsObject().id);
        }
        stmt.free();

        for (const mId of msgIds) {
          this.db.run('DELETE FROM reactions WHERE message_id = ?', [mId]);
        }
        this.db.run('DELETE FROM messages WHERE room_id = ?', [id]);
        this.db.run('DELETE FROM channel_members WHERE channel_id = ?', [id]);
        this.db.run('DELETE FROM channels WHERE id = ?', [id]);
      } catch (e) {
        console.warn(`Note cleaning legacy channel ${id}:`, e.message);
      }
    }
  }

  seedDefaultChannelsLocal() {
    const defaults = [
      { id: 'chan_general', name: 'General', description: 'The town square - hang out, chat and say hello to everyone!', icon: '💬' }
    ];

    for (const c of defaults) {
      const stmt = this.db.prepare('SELECT id FROM channels WHERE id = :id OR name = :name');
      stmt.bind({ ':id': c.id, ':name': c.name });
      const exists = stmt.step();
      stmt.free();

      if (!exists) {
        this.db.run(
          'INSERT INTO channels (id, name, description, icon, is_private, created_by, created_at) VALUES (?, ?, ?, ?, 0, "system", ?)',
          [c.id, c.name, c.description, c.icon, Date.now()]
        );
      }
      try {
        this.db.run('UPDATE channels SET name = "General" WHERE id = "chan_general"');
      } catch (e) {}
    }
  }

  // --- QUERY EXECUTION (UNIFIED ASYNC) ---
  async run(sql, params = []) {
    if (this.isTurso) {
      await this.tursoClient.execute({ sql, args: params });
    } else {
      this.db.run(sql, params);
      this.saveLocal();
    }
  }

  async getOne(sql, params = []) {
    if (this.isTurso) {
      const res = await this.tursoClient.execute({ sql, args: params });
      return res.rows.length > 0 ? res.rows[0] : null;
    } else {
      const stmt = this.db.prepare(sql);
      stmt.bind(params);
      let row = null;
      if (stmt.step()) {
        row = stmt.getAsObject();
      }
      stmt.free();
      return row;
    }
  }

  async getAll(sql, params = []) {
    if (this.isTurso) {
      const res = await this.tursoClient.execute({ sql, args: params });
      return res.rows;
    } else {
      const stmt = this.db.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      return rows;
    }
  }

  // --- USER QUERIES ---
  async getUserById(id) {
    return await this.getOne('SELECT id, username, display_name, avatar_color, avatar_url, bio, status, is_guest, created_at, last_seen FROM users WHERE id = ?', [id]);
  }

  async getUserWithPassword(username) {
    return await this.getOne('SELECT * FROM users WHERE LOWER(username) = LOWER(?)', [username]);
  }

  async getUserByUsername(username) {
    return await this.getOne('SELECT id, username, display_name, avatar_color, avatar_url, bio, status, is_guest, created_at, last_seen FROM users WHERE LOWER(username) = LOWER(?)', [username]);
  }

  async createUser({ id, username, display_name, password_hash, avatar_color, avatar_url, bio, is_guest = 0 }) {
    const now = Date.now();
    await this.run(
      `INSERT INTO users (id, username, display_name, password_hash, avatar_color, avatar_url, bio, status, is_guest, created_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'online', ?, ?, ?)`,
      [id, username, display_name, password_hash || null, avatar_color || '#6366f1', avatar_url || null, bio || '', is_guest ? 1 : 0, now, now]
    );
    return await this.getUserById(id);
  }

  async updateUserStatus(id, status) {
    const now = Date.now();
    await this.run('UPDATE users SET status = ?, last_seen = ? WHERE id = ?', [status, now, id]);
  }

  async updateUserProfile(id, { display_name, bio, avatar_color, avatar_url }) {
    await this.run(
      'UPDATE users SET display_name = COALESCE(?, display_name), bio = COALESCE(?, bio), avatar_color = COALESCE(?, avatar_color), avatar_url = COALESCE(?, avatar_url) WHERE id = ?',
      [display_name, bio, avatar_color, avatar_url, id]
    );
    return await this.getUserById(id);
  }

  async getAllUsers() {
    return await this.getAll('SELECT id, username, display_name, avatar_color, avatar_url, bio, status, is_guest, created_at, last_seen FROM users ORDER BY last_seen DESC');
  }

  // --- CHANNEL QUERIES ---
  async getChannels(userId = null) {
    if (!userId) {
      return await this.getAll("SELECT * FROM channels WHERE id = 'chan_general' ORDER BY created_at ASC");
    }
    const sql = `
      SELECT DISTINCT c.* 
      FROM channels c
      LEFT JOIN channel_members cm ON c.id = cm.channel_id
      WHERE c.id = 'chan_general' OR c.created_by = ? OR cm.user_id = ?
      ORDER BY c.created_at ASC
    `;
    return await this.getAll(sql, [userId, userId]);
  }

  async getChannelById(id) {
    return await this.getOne('SELECT * FROM channels WHERE id = ?', [id]);
  }

  async getChannelMemberIds(channelId) {
    const rows = await this.getAll('SELECT user_id FROM channel_members WHERE channel_id = ?', [channelId]);
    return rows.map(r => r.user_id);
  }

  async createChannel({ id, name, description, icon, is_private = 0, created_by, members = [] }) {
    const cleanName = name.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    const now = Date.now();
    await this.run(
      'INSERT INTO channels (id, name, description, icon, is_private, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, cleanName, description || '', icon || '💬', is_private ? 1 : 0, created_by, now]
    );

    if (created_by && created_by !== 'system') {
      await this.run(
        'INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)',
        [id, created_by, now]
      );
    }

    if (Array.isArray(members)) {
      for (const memberId of members) {
        if (memberId && memberId !== created_by) {
          await this.run(
            'INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)',
            [id, memberId, now]
          );
        }
      }
    }

    const chan = await this.getChannelById(id);
    const memberIds = await this.getChannelMemberIds(id);
    return { ...chan, member_ids: memberIds };
  }

  async deleteChannel(channelId, userId) {
    const chan = await this.getChannelById(channelId);
    if (!chan) return { error: 'Channel not found' };

    const defaultIds = ['chan_general'];
    if (defaultIds.includes(channelId)) {
      return { error: 'General chat cannot be deleted' };
    }

    if (chan.created_by !== userId) {
      return { error: 'Only the group creator can delete this channel' };
    }

    const messages = await this.getAll('SELECT id FROM messages WHERE room_id = ?', [channelId]);
    for (const m of messages) {
      await this.run('DELETE FROM reactions WHERE message_id = ?', [m.id]);
    }
    await this.run('DELETE FROM messages WHERE room_id = ?', [channelId]);
    await this.run('DELETE FROM channel_members WHERE channel_id = ?', [channelId]);
    await this.run('DELETE FROM channels WHERE id = ?', [channelId]);
    return { success: true, channel: chan };
  }

  async leaveChannel(channelId, userId) {
    const chan = await this.getChannelById(channelId);
    if (!chan) return { error: 'Channel not found' };

    const defaultIds = ['chan_general'];
    if (defaultIds.includes(channelId)) {
      return { error: 'Cannot leave General chat' };
    }

    await this.run('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?', [channelId, userId]);
    return { success: true };
  }

  async removeChannelMember(channelId, targetUserId, creatorUserId) {
    const chan = await this.getChannelById(channelId);
    if (!chan) return { error: 'Channel not found' };

    if (chan.created_by !== creatorUserId) {
      return { error: 'Only the group creator can remove members' };
    }

    if (targetUserId === creatorUserId) {
      return { error: 'Creator cannot be removed from the group' };
    }

    await this.run('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?', [channelId, targetUserId]);
    return { success: true };
  }

  async getChannelMembers(channelId) {
    const sql = `
      SELECT u.id, u.username, u.display_name, u.avatar_color, u.status, u.bio, cm.joined_at
      FROM channel_members cm
      JOIN users u ON cm.user_id = u.id
      WHERE cm.channel_id = ?
      ORDER BY u.display_name ASC
    `;
    return await this.getAll(sql, [channelId]);
  }

  // --- MESSAGE QUERIES ---
  async saveMessage(msg) {
    await this.run(
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
    return await this.getMessageWithSender(msg.id);
  }

  async getMessageWithSender(id) {
    const msg = await this.getOne(`
      SELECT m.*, u.username as sender_username, u.display_name as sender_display_name, u.avatar_color as sender_avatar_color, u.avatar_url as sender_avatar_url
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.id = ?
    `, [id]);
    if (msg) {
      msg.reactions = await this.getReactionsForMessage(id);
    }
    return msg;
  }

  async getMessages(roomId, limit = 50, beforeTimestamp = null) {
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

    const rows = (await this.getAll(sql, params)).reverse();
    
    for (const row of rows) {
      row.reactions = await this.getReactionsForMessage(row.id);
    }
    return rows;
  }

  async deleteMessage(messageId, userId) {
    const msg = await this.getOne('SELECT * FROM messages WHERE id = ?', [messageId]);
    if (!msg) return null;
    if (msg.sender_id !== userId) return false;

    await this.run('DELETE FROM reactions WHERE message_id = ?', [messageId]);
    await this.run('DELETE FROM messages WHERE id = ?', [messageId]);
    return true;
  }

  async editMessage(messageId, userId, newContent) {
    const msg = await this.getOne('SELECT * FROM messages WHERE id = ?', [messageId]);
    if (!msg) return null;
    if (msg.sender_id !== userId) return false;

    await this.run('UPDATE messages SET content = ?, is_edited = 1 WHERE id = ?', [newContent, messageId]);
    return await this.getMessageWithSender(messageId);
  }

  async searchMessages(query, roomId = null) {
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
    return await this.getAll(sql, params);
  }

  // --- REACTIONS ---
  async addReaction({ id, message_id, user_id, username, emoji }) {
    try {
      await this.run(
        'INSERT OR REPLACE INTO reactions (id, message_id, user_id, username, emoji, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, message_id, user_id, username, emoji, Date.now()]
      );
      return await this.getReactionsForMessage(message_id);
    } catch (err) {
      return await this.getReactionsForMessage(message_id);
    }
  }

  async removeReaction(messageId, userId, emoji) {
    await this.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [messageId, userId, emoji]);
    return await this.getReactionsForMessage(messageId);
  }

  async getReactionsForMessage(messageId) {
    const rows = await this.getAll('SELECT emoji, user_id, username FROM reactions WHERE message_id = ?', [messageId]);
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

  async getDirectMessageRooms(userId) {
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
    const rooms = await this.getAll(sql, [userId, userId, userId]);
    const result = [];
    for (const r of rooms) {
      const partner = await this.getUserById(r.partner_id);
      result.push({
        room_id: r.room_id,
        partner: partner || { id: r.partner_id, username: 'Unknown User', status: 'offline' },
        last_activity: r.last_activity
      });
    }
    return result;
  }

  // --- FRIEND REQUESTS & RELATIONSHIPS ---
  async sendFriendRequest(senderId, targetIdentifier) {
    if (!targetIdentifier || !targetIdentifier.trim()) {
      return { error: 'Please enter a username or user ID' };
    }

    const clean = targetIdentifier.trim().toLowerCase();
    let receiver = await this.getOne('SELECT * FROM users WHERE id = ? OR LOWER(username) = ?', [clean, clean]);
    if (!receiver) {
      return { error: 'User not found. Check the username or ID and try again.' };
    }

    if (receiver.id === senderId) {
      return { error: 'You cannot send a friend request to yourself.' };
    }

    // Check existing relation
    const existing = await this.getOne(
      'SELECT * FROM friend_requests WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)',
      [senderId, receiver.id, receiver.id, senderId]
    );

    const now = Date.now();

    if (existing) {
      if (existing.status === 'accepted') {
        return { error: `You and @${receiver.username} are already friends!` };
      }
      if (existing.sender_id === senderId && existing.status === 'pending') {
        return { error: `Friend request to @${receiver.username} is already pending.` };
      }
      if (existing.sender_id === receiver.id && existing.status === 'pending') {
        // Auto accept reverse request
        await this.run('UPDATE friend_requests SET status = "accepted", updated_at = ? WHERE id = ?', [now, existing.id]);
        const friendUser = await this.getUserById(receiver.id);
        return { success: true, auto_accepted: true, message: `You and @${receiver.username} are now friends!`, friend: friendUser, requestId: existing.id, receiver_id: receiver.id };
      }
      // If rejected or cancelled, reopen as pending
      await this.run('UPDATE friend_requests SET sender_id = ?, receiver_id = ?, status = "pending", updated_at = ? WHERE id = ?', [senderId, receiver.id, now, existing.id]);
      return { success: true, message: `Friend request sent to @${receiver.username}!`, receiver, requestId: existing.id };
    }

    const reqId = `freq_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    await this.run(
      'INSERT INTO friend_requests (id, sender_id, receiver_id, status, created_at, updated_at) VALUES (?, ?, ?, "pending", ?, ?)',
      [reqId, senderId, receiver.id, now, now]
    );

    return { success: true, message: `Friend request sent to @${receiver.username}!`, receiver, requestId: reqId };
  }

  async getFriendRequests(userId) {
    const incomingSql = `
      SELECT fr.id as request_id, fr.created_at, fr.status,
             u.id as user_id, u.username, u.display_name, u.avatar_color, u.avatar_url, u.bio, u.status as user_status, u.last_seen
      FROM friend_requests fr
      JOIN users u ON fr.sender_id = u.id
      WHERE fr.receiver_id = ? AND fr.status = 'pending'
      ORDER BY fr.created_at DESC
    `;
    const outgoingSql = `
      SELECT fr.id as request_id, fr.created_at, fr.status,
             u.id as user_id, u.username, u.display_name, u.avatar_color, u.avatar_url, u.bio, u.status as user_status, u.last_seen
      FROM friend_requests fr
      JOIN users u ON fr.receiver_id = u.id
      WHERE fr.sender_id = ? AND fr.status = 'pending'
      ORDER BY fr.created_at DESC
    `;

    const incoming = await this.getAll(incomingSql, [userId]);
    const outgoing = await this.getAll(outgoingSql, [userId]);
    return { incoming, outgoing };
  }

  async acceptFriendRequest(requestId, userId) {
    const req = await this.getOne('SELECT * FROM friend_requests WHERE id = ? AND receiver_id = ?', [requestId, userId]);
    if (!req) {
      return { error: 'Friend request not found or not addressed to you' };
    }
    if (req.status === 'accepted') {
      return { error: 'Request is already accepted' };
    }

    const now = Date.now();
    await this.run('UPDATE friend_requests SET status = "accepted", updated_at = ? WHERE id = ?', [now, requestId]);

    const senderUser = await this.getUserById(req.sender_id);
    const receiverUser = await this.getUserById(req.receiver_id);
    return { success: true, sender: senderUser, receiver: receiverUser, requestId };
  }

  async rejectFriendRequest(requestId, userId) {
    const req = await this.getOne('SELECT * FROM friend_requests WHERE id = ? AND (receiver_id = ? OR sender_id = ?)', [requestId, userId, userId]);
    if (!req) {
      return { error: 'Friend request not found' };
    }

    await this.run('DELETE FROM friend_requests WHERE id = ?', [requestId]);
    return { success: true, requestId, sender_id: req.sender_id, receiver_id: req.receiver_id };
  }

  async getFriends(userId) {
    const sql = `
      SELECT u.id, u.username, u.display_name, u.avatar_color, u.avatar_url, u.bio, u.status, u.last_seen, fr.updated_at as friendship_since
      FROM friend_requests fr
      JOIN users u ON (CASE WHEN fr.sender_id = ? THEN fr.receiver_id ELSE fr.sender_id END) = u.id
      WHERE (fr.sender_id = ? OR fr.receiver_id = ?) AND fr.status = 'accepted'
      ORDER BY u.display_name ASC
    `;
    return await this.getAll(sql, [userId, userId, userId]);
  }

  async searchUsers(query, currentUserId) {
    const clean = `%${(query || '').trim().toLowerCase()}%`;
    const users = await this.getAll(`
      SELECT id, username, display_name, avatar_color, avatar_url, bio, status, last_seen
      FROM users
      WHERE id != ? AND (LOWER(username) LIKE ? OR LOWER(display_name) LIKE ? OR id LIKE ?)
      LIMIT 20
    `, [currentUserId, clean, clean, clean]);

    const result = [];
    for (const u of users) {
      const rel = await this.getOne(`
        SELECT id, sender_id, receiver_id, status
        FROM friend_requests
        WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
      `, [currentUserId, u.id, u.id, currentUserId]);

      let relationship = 'none';
      let requestId = null;
      if (rel) {
        requestId = rel.id;
        if (rel.status === 'accepted') {
          relationship = 'friends';
        } else if (rel.status === 'pending') {
          relationship = rel.sender_id === currentUserId ? 'pending_sent' : 'pending_received';
        }
      }

      result.push({
        ...u,
        relationship,
        request_id: requestId
      });
    }
    return result;
  }

  async removeFriend(userId, friendId) {
    await this.run(`
      DELETE FROM friend_requests 
      WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
    `, [userId, friendId, friendId, userId]);
    return { success: true };
  }

  async getStats() {
    const { url, token, isConfigured } = getTursoCredentials();
    const uRow = await this.getOne('SELECT COUNT(*) as count FROM users');
    const mRow = await this.getOne('SELECT COUNT(*) as count FROM messages');
    const cRow = await this.getOne('SELECT COUNT(*) as count FROM channels');
    let dbSize = 0;
    if (!this.isTurso && fs.existsSync(DB_PATH)) {
      dbSize = fs.statSync(DB_PATH).size;
    }
    const detectedEnvKeys = Object.keys(process.env).filter(k => /turso|database|libsql/i.test(k));
    return {
      storage: this.isTurso ? 'Turso Cloud SQLite' : 'Local SQLite',
      turso_configured: isConfigured,
      turso_url_set: Boolean(url),
      turso_token_set: Boolean(token),
      turso_error: this.tursoError || null,
      detected_turso_keys: detectedEnvKeys,
      users: uRow ? uRow.count : 0,
      messages: mRow ? mRow.count : 0,
      channels: cRow ? cRow.count : 0,
      db_size_kb: Math.round(dbSize / 1024)
    };
  }
}

const dbService = new DatabaseService();
module.exports = dbService;
