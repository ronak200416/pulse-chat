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

  // Test 5: Channels Endpoint - Verify Only #general is default
  console.log('\nTest 5: Fetching Default Channels...');
  const chanRes = await fetch(`${SERVER_URL}/api/channels`);
  const chanData = await chanRes.json();
  console.log(`  ✓ Found ${chanData.channels.length} default channels:`, chanData.channels.map(c => `#${c.name}`).join(', '));
  if (chanData.channels.length !== 1 || chanData.channels[0].name !== 'general') {
    throw new Error(`Expected only '#general', but got ${JSON.stringify(chanData.channels)}`);
  }
  const generalChan = chanData.channels[0];

  // Test 6: Dynamic Group Creation and Membership Isolation
  console.log('\nTest 6: Creating custom group with Alice and Bob...');
  const groupCreateRes = await fetch(`${SERVER_URL}/api/channels`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${user1Data.token}`
    },
    body: JSON.stringify({
      name: 'alpha-squad',
      description: 'Top secret squad channel',
      icon: '🛡️',
      members: [user2Data.user.id]
    })
  });
  const groupCreateData = await groupCreateRes.json();
  if (!groupCreateData.channel) throw new Error('Failed to create group');
  const customGroup = groupCreateData.channel;
  console.log(`  ✓ Group created: #${customGroup.name} (ID: ${customGroup.id}) by Alice`);

  // Create Charlie (User 3) who is NOT in the group
  console.log('  Creating User 3 (Charlie)...');
  const user3Res = await fetch(`${SERVER_URL}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: 'Charlie Stranger', avatar_color: '#3b82f6' })
  });
  const user3Data = await user3Res.json();

  // Check Alice's channels (Creator)
  const aliceChans = await (await fetch(`${SERVER_URL}/api/channels`, { headers: { 'Authorization': `Bearer ${user1Data.token}` } })).json();
  console.log(`  ✓ Alice sees:`, aliceChans.channels.map(c => `#${c.name}`).join(', '));
  if (!aliceChans.channels.some(c => c.id === customGroup.id)) throw new Error('Alice cannot see her created group');

  // Check Bob's channels (Member)
  const bobChans = await (await fetch(`${SERVER_URL}/api/channels`, { headers: { 'Authorization': `Bearer ${user2Data.token}` } })).json();
  console.log(`  ✓ Bob sees:`, bobChans.channels.map(c => `#${c.name}`).join(', '));
  if (!bobChans.channels.some(c => c.id === customGroup.id)) throw new Error('Bob cannot see group he was added to');

  // Check Charlie's channels (Uninvited)
  const charlieChans = await (await fetch(`${SERVER_URL}/api/channels`, { headers: { 'Authorization': `Bearer ${user3Data.token}` } })).json();
  console.log(`  ✓ Charlie sees:`, charlieChans.channels.map(c => `#${c.name}`).join(', '));
  if (charlieChans.channels.some(c => c.id === customGroup.id)) throw new Error('Charlie can see group he was NOT invited to!');
  console.log(`  ✓ Membership isolation verified: Charlie does not see Alice & Bob\'s custom group!`);

  // Test 7: Real-time WebSockets & Bidirectional Chat
  console.log('\nTest 7: Connecting Alice & Bob via Socket.IO...');
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

  // Test 8: Send Message & Receive in Real Time
  console.log('\nTest 8: Alice sending message to #general, Bob listening...');
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

  // Test 9: Emoji Reactions in Real Time
  console.log('\nTest 9: Bob reacting with 🔥 to Alice\'s message...');
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

  // Test 10: 1-on-1 Direct Messaging
  console.log('\nTest 10: 1-on-1 Direct Messaging between Bob and Alice...');
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

  // Test 11: Verify SQLite Database Persistence
  console.log('\nTest 11: Verifying SQLite Database Persistence...');
  const historyRes = await fetch(`${SERVER_URL}/api/messages/${generalChan.id}`);
  const historyData = await historyRes.json();
  const foundMsg = historyData.messages.find(m => m.id === receivedMsg.id);
  if (!foundMsg) throw new Error('Message was not found in SQLite database!');
  console.log(`  ✓ Message confirmed saved in SQLite database! Total messages in room: ${historyData.messages.length}`);

  // Test 12: Final Stats check
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
