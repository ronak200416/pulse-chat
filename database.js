require('dotenv').config();
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { createClient } = require('@libsql/client');

const DB_PATH = path.join(__dirname, 'database.sqlite');
const TURSO_URL = process.env.TURSO_DATABASE_URL || process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || process.env.TURSO_TOKEN;

class DatabaseService {
  constructor() {
    this.isTurso = Boolean(TURSO_URL);
    this.tursoClient = null;
    this.db = null; // Local sql.js
    this.SQL = null;
  }

  async init() {
    if (this.isTurso) {
      console.log('⚡ Connecting to Turso Cloud SQLite database...');
      this.tursoClient = createClient({
        url: TURSO_URL,
        authToken: TURSO_TOKEN
      });
      await this.createTablesTurso();
      await this.cleanupLegacyChannelsTurso();
      await this.cleanupGuestAndBotAccountsTurso();
      await this.seedDefaultChannelsTurso();
      console.log('🌟 Connected to Turso Cloud SQLite with 100% PERMANENT cloud storage!');
      return this;
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
    this.cleanupGuestAndBotAccountsLocal();
    this.seedDefaultChannelsLocal();
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

      CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(message_id);
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

  async cleanupGuestAndBotAccountsTurso() {
    try {
      const guests = await this.getAll(`
        SELECT id FROM users WHERE is_guest = 1 
          OR username LIKE 'guest_%' 
          OR username LIKE 'bot_%' 
          OR id LIKE 'guest_%'
          OR username LIKE 'alice_%'
          OR username LIKE 'bob_%'
          OR username LIKE 'charlie_%'
          OR username LIKE '%_test_%'
          OR username LIKE 'test_%'
          OR display_name LIKE '%Tester%'
          OR display_name LIKE '%Builder%'
          OR display_name LIKE '%Stranger%'
          OR display_name LIKE '%Wonder%'
      `);
      for (const g of guests) {
        // Delete channels created by test user
        const chs = await this.getAll('SELECT id FROM channels WHERE created_by = ?', [g.id]);
        for (const ch of chs) {
          if (ch.id !== 'chan_general') {
            const msgs = await this.getAll('SELECT id FROM messages WHERE room_id = ?', [ch.id]);
            for (const m of msgs) {
              await this.run('DELETE FROM reactions WHERE message_id = ?', [m.id]);
            }
            await this.run('DELETE FROM messages WHERE room_id = ?', [ch.id]);
            await this.run('DELETE FROM channel_members WHERE channel_id = ?', [ch.id]);
            await this.run('DELETE FROM channels WHERE id = ?', [ch.id]);
          }
        }
        await this.run('DELETE FROM reactions WHERE user_id = ?', [g.id]);
        await this.run('DELETE FROM channel_members WHERE user_id = ?', [g.id]);
        await this.run('DELETE FROM messages WHERE sender_id = ? OR recipient_id = ?', [g.id, g.id]);
        await this.run('DELETE FROM users WHERE id = ?', [g.id]);
      }
    } catch (e) {
      console.warn('Note cleaning guest/bot accounts in Turso:', e.message);
    }
  }

  async seedDefaultChannelsTurso() {
    const defaults = [
      { id: 'chan_general', name: 'general', description: 'The town square - hang out, chat and say hello to everyone!', icon: '💬' }
    ];

    for (const c of defaults) {
      await this.tursoClient.execute({
        sql: 'INSERT OR IGNORE INTO channels (id, name, description, icon, is_private, created_by, created_at) VALUES (?, ?, ?, ?, 0, "system", ?)',
        args: [c.id, c.name, c.description, c.icon, Date.now()]
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

      CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(message_id);
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

  cleanupGuestAndBotAccountsLocal() {
    try {
      const stmt = this.db.prepare(`
        SELECT id FROM users WHERE is_guest = 1 
          OR username LIKE 'guest_%' 
          OR username LIKE 'bot_%' 
          OR id LIKE 'guest_%'
          OR username LIKE 'alice_%'
          OR username LIKE 'bob_%'
          OR username LIKE 'charlie_%'
          OR username LIKE '%_test_%'
          OR username LIKE 'test_%'
          OR display_name LIKE '%Tester%'
          OR display_name LIKE '%Builder%'
          OR display_name LIKE '%Stranger%'
          OR display_name LIKE '%Wonder%'
      `);
      const guestIds = [];
      while (stmt.step()) {
        guestIds.push(stmt.getAsObject().id);
      }
      stmt.free();

      for (const gId of guestIds) {
        // Delete channels created by test user
        const chStmt = this.db.prepare('SELECT id FROM channels WHERE created_by = :uid');
        chStmt.bind({ ':uid': gId });
        const chIds = [];
        while (chStmt.step()) {
          const ch = chStmt.getAsObject();
          if (ch.id !== 'chan_general') chIds.push(ch.id);
        }
        chStmt.free();

        for (const chId of chIds) {
          const mStmt = this.db.prepare('SELECT id FROM messages WHERE room_id = :rid');
          mStmt.bind({ ':rid': chId });
          const mIds = [];
          while (mStmt.step()) {
            mIds.push(mStmt.getAsObject().id);
          }
          mStmt.free();

          for (const mId of mIds) {
            this.db.run('DELETE FROM reactions WHERE message_id = ?', [mId]);
          }
          this.db.run('DELETE FROM messages WHERE room_id = ?', [chId]);
          this.db.run('DELETE FROM channel_members WHERE channel_id = ?', [chId]);
          this.db.run('DELETE FROM channels WHERE id = ?', [chId]);
        }

        this.db.run('DELETE FROM reactions WHERE user_id = ?', [gId]);
        this.db.run('DELETE FROM channel_members WHERE user_id = ?', [gId]);
        this.db.run('DELETE FROM messages WHERE sender_id = ? OR recipient_id = ?', [gId, gId]);
        this.db.run('DELETE FROM users WHERE id = ?', [gId]);
      }
    } catch (e) {
      console.warn('Note cleaning guest/bot accounts in Local SQLite:', e.message);
    }
  }

  seedDefaultChannelsLocal() {
    const defaults = [
      { id: 'chan_general', name: 'general', description: 'The town square - hang out, chat and say hello to everyone!', icon: '💬' }
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

  async getStats() {
    const uRow = await this.getOne('SELECT COUNT(*) as count FROM users');
    const mRow = await this.getOne('SELECT COUNT(*) as count FROM messages');
    const cRow = await this.getOne('SELECT COUNT(*) as count FROM channels');
    let dbSize = 0;
    if (!this.isTurso && fs.existsSync(DB_PATH)) {
      dbSize = fs.statSync(DB_PATH).size;
    }
    return {
      storage: this.isTurso ? 'Turso Cloud SQLite' : 'Local SQLite',
      users: uRow ? uRow.count : 0,
      messages: mRow ? mRow.count : 0,
      channels: cRow ? cRow.count : 0,
      db_size_kb: Math.round(dbSize / 1024)
    };
  }
}

const dbService = new DatabaseService();
module.exports = dbService;
