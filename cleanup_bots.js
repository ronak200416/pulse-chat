const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, 'database.sqlite');

async function cleanup() {
  const SQL = await initSqlJs();
  if (!fs.existsSync(DB_PATH)) {
    console.log('No database.sqlite found.');
    return;
  }

  const fileBuffer = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(fileBuffer);

  // 1. Get bot/test user IDs
  const botStmt = db.prepare(`
    SELECT id, username, display_name FROM users 
    WHERE username LIKE 'alice_%' 
       OR username LIKE 'bob_%' 
       OR username LIKE 'bot_%' 
       OR username LIKE 'guest_%'
       OR display_name LIKE '%Bob The Builder%'
       OR display_name LIKE '%Alice Wonder%'
       OR username LIKE 'test_%'
       OR username LIKE '%_test_%'
  `);
  
  const botIds = [];
  while (botStmt.step()) {
    const row = botStmt.getAsObject();
    botIds.push(row.id);
    console.log(`Deleting bot account: ${row.display_name} (@${row.username}) [${row.id}]`);
  }
  botStmt.free();

  for (const id of botIds) {
    db.run('DELETE FROM reactions WHERE user_id = ?', [id]);
    db.run('DELETE FROM channel_members WHERE user_id = ?', [id]);
    db.run('DELETE FROM friend_requests WHERE sender_id = ? OR receiver_id = ?', [id, id]);
    db.run('DELETE FROM messages WHERE sender_id = ? OR recipient_id = ?', [id, id]);
    db.run('DELETE FROM users WHERE id = ?', [id]);
  }

  // Also remove any test messages
  db.run("DELETE FROM messages WHERE content LIKE '%Anonymous check%' OR content LIKE '%Hello from Alice%' OR content LIKE '%Private DM confirmed%'");

  const usersStmt = db.prepare('SELECT id, username, display_name FROM users');
  const remaining = [];
  while (usersStmt.step()) {
    remaining.push(usersStmt.getAsObject());
  }
  usersStmt.free();

  console.log('\n✅ Remaining Real Users in Database:', remaining);

  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
  console.log('📦 database.sqlite updated successfully.');
  process.exit(0);
}

cleanup().catch(err => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
