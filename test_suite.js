const io = require('socket.io-client');

const SERVER_URL = 'http://localhost:3000';

async function runTests() {
  console.log('🧪 Starting Pulse Chat End-to-End Integration Test Suite...\n');

  // Test 1: Network & Server Info Endpoint
  console.log('Test 1: Testing /api/network-info...');
  const netRes = await fetch(`${SERVER_URL}/api/network-info`);
  if (!netRes.ok) throw new Error('Network info endpoint failed');
  const netData = await netRes.json();
  console.log(`  ✓ Local URL: ${netData.localUrl}`);
  console.log(`  ✓ Wi-Fi LAN IP: ${netData.lanIp}`);
  console.log(`  ✓ QR Code Generated: ${netData.qrCode ? 'YES (Base64 Data URI)' : 'NO'}`);
  console.log(`  ✓ Initial Stats:`, netData.stats);

  // Test 2: Create Fast Guest User 1 (Alice)
  console.log('\nTest 2: Authenticating User 1 (Alice)...');
  const user1Res = await fetch(`${SERVER_URL}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: 'Alice Wonder', avatar_color: '#ec4899' })
  });
  const user1Data = await user1Res.json();
  if (!user1Data.token) throw new Error('User 1 guest auth failed');
  console.log(`  ✓ User 1 created: ${user1Data.user.display_name} (@${user1Data.user.username})`);

  // Test 3: Register Standard User 2 (Bob)
  console.log('\nTest 3: Registering User 2 (Bob)...');
  const bobUsername = `bob_${Date.now().toString().slice(-4)}`;
  const user2Res = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: bobUsername,
      display_name: 'Bob The Builder',
      password: 'superpassword123',
      bio: 'Building awesome apps 🚀',
      avatar_color: '#10b981'
    })
  });
  const user2Data = await user2Res.json();
  if (!user2Data.token) throw new Error('User 2 registration failed');
  console.log(`  ✓ User 2 registered: ${user2Data.user.display_name} (@${user2Data.user.username})`);

  // Test 4: Verify User 2 Login
  console.log('\nTest 4: Logging in User 2...');
  const loginRes = await fetch(`${SERVER_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: bobUsername, password: 'superpassword123' })
  });
  const loginData = await loginRes.json();
  if (!loginData.token) throw new Error('User 2 login failed');
  console.log(`  ✓ Login verified, token generated.`);

  // Test 5: Channels Endpoint
  console.log('\nTest 5: Fetching Default Channels...');
  const chanRes = await fetch(`${SERVER_URL}/api/channels`);
  const chanData = await chanRes.json();
  console.log(`  ✓ Found ${chanData.channels.length} channels:`, chanData.channels.map(c => `#${c.name}`).join(', '));
  const generalChan = chanData.channels.find(c => c.name === 'general') || chanData.channels[0];

  // Test 6: Real-time WebSockets & Bidirectional Chat
  console.log('\nTest 6: Connecting Alice & Bob via Socket.IO...');
  const socketAlice = io(SERVER_URL);
  const socketBob = io(SERVER_URL);

  await new Promise((resolve, reject) => {
    let connected = 0;
    const onConnect = () => {
      connected++;
      if (connected === 2) resolve();
    };
    socketAlice.on('connect', onConnect);
    socketBob.on('connect', onConnect);
    setTimeout(() => reject(new Error('Socket connection timed out')), 5000);
  });
  console.log('  ✓ Both sockets connected to server.');

  // Authenticate sockets
  socketAlice.emit('authenticate', user1Data.token);
  socketBob.emit('authenticate', user2Data.token);
  await new Promise(r => setTimeout(r, 500));
  console.log('  ✓ Sockets authenticated.');

  // Join #general channel
  socketAlice.emit('join_room', generalChan.id);
  socketBob.emit('join_room', generalChan.id);
  await new Promise(r => setTimeout(r, 300));
  console.log(`  ✓ Both users joined #${generalChan.name}.`);

  // Test 7: Send Message & Receive in Real Time
  console.log('\nTest 7: Alice sending message to #general, Bob listening...');
  const messagePromise = new Promise((resolve, reject) => {
    socketBob.on('new_message', (msg) => {
      if (msg.content.includes('Hello Bob!')) {
        resolve(msg);
      }
    });
    setTimeout(() => reject(new Error('Message reception timed out')), 5000);
  });

  socketAlice.emit('send_message', {
    room_type: 'channel',
    room_id: generalChan.id,
    content: 'Hello Bob! Pulse Chat is live and running in SQLite! 🚀',
    message_type: 'text'
  });

  const receivedMsg = await messagePromise;
  console.log(`  ✓ Bob received message in real time: "${receivedMsg.content}" (ID: ${receivedMsg.id})`);

  // Test 8: Emoji Reactions in Real Time
  console.log('\nTest 8: Bob reacting with 🔥 to Alice\'s message...');
  const reactionPromise = new Promise((resolve, reject) => {
    socketAlice.on('reaction_updated', ({ messageId, reactions }) => {
      if (messageId === receivedMsg.id) {
        resolve(reactions);
      }
    });
    setTimeout(() => reject(new Error('Reaction reception timed out')), 5000);
  });

  socketBob.emit('add_reaction', {
    messageId: receivedMsg.id,
    emoji: '🔥',
    roomId: generalChan.id
  });

  const reactions = await reactionPromise;
  console.log(`  ✓ Alice received reaction update:`, reactions);

  // Test 9: 1-on-1 Direct Messaging
  console.log('\nTest 9: 1-on-1 Direct Messaging between Bob and Alice...');
  const dmRoomId = [user1Data.user.id, user2Data.user.id].sort().join('_');
  socketAlice.emit('join_room', `dm_${dmRoomId}`);
  socketBob.emit('join_room', `dm_${dmRoomId}`);
  await new Promise(r => setTimeout(r, 300));

  const dmPromise = new Promise((resolve, reject) => {
    socketAlice.on('new_message', (msg) => {
      if (msg.room_type === 'direct' && msg.content.includes('private message')) {
        resolve(msg);
      }
    });
    setTimeout(() => reject(new Error('DM reception timed out')), 5000);
  });

  socketBob.emit('send_message', {
    room_type: 'direct',
    room_id: `dm_${dmRoomId}`,
    recipient_id: user1Data.user.id,
    content: 'Hey Alice, this is a private message between you and me!',
    message_type: 'text'
  });

  const receivedDm = await dmPromise;
  console.log(`  ✓ Alice received DM: "${receivedDm.content}"`);

  // Test 10: Verify SQLite Database Persistence
  console.log('\nTest 10: Verifying SQLite Database Persistence...');
  const historyRes = await fetch(`${SERVER_URL}/api/messages/${generalChan.id}`);
  const historyData = await historyRes.json();
  const foundMsg = historyData.messages.find(m => m.id === receivedMsg.id);
  if (!foundMsg) throw new Error('Message was not found in SQLite database!');
  console.log(`  ✓ Message confirmed saved in SQLite database! Total messages in room: ${historyData.messages.length}`);

  // Test 11: Final Stats check
  const finalStatsRes = await fetch(`${SERVER_URL}/api/network-info`);
  const finalStats = await finalStatsRes.json();
  console.log(`  ✓ Updated Database Stats:`, finalStats.stats);

  // Cleanup
  socketAlice.disconnect();
  socketBob.disconnect();

  console.log('\n======================================================');
  console.log('🎉 ALL INTEGRATION TESTS PASSED WITH 100% SUCCESS!');
  console.log('======================================================\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
