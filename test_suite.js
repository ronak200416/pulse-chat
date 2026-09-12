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
  console.log(`  ✓ LAN IP: ${netData.lanIp}`);
  console.log(`  ✓ Initial Stats:`, netData.stats);

  // Test 2: Check Username Availability API
  console.log('\nTest 2: Testing /api/auth/check-username endpoint...');
  const aliceUsername = `alice_${Date.now().toString().slice(-4)}`;
  const checkAvailRes = await fetch(`${SERVER_URL}/api/auth/check-username?username=${aliceUsername}`);
  const checkAvailData = await checkAvailRes.json();
  if (!checkAvailData.available) throw new Error('Expected username to be available');
  console.log(`  ✓ Username "${aliceUsername}" is available.`);

  // Test 3: Register User 1 (Alice) with Password
  console.log('\nTest 3: Registering User 1 (Alice)...');
  const user1Res = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: aliceUsername,
      display_name: 'Alice Wonder',
      password: 'alice_password_123',
      bio: 'Exploring cyberspace 🌟',
      avatar_color: '#ec4899'
    })
  });
  const user1Data = await user1Res.json();
  if (!user1Data.token) throw new Error('User 1 registration failed');
  console.log(`  ✓ User 1 registered: ${user1Data.user.display_name} (@${user1Data.user.username})`);

  // Test 4: Register User 2 (Bob)
  console.log('\nTest 4: Registering User 2 (Bob)...');
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

  // Test 5: Search User by Username / ID
  console.log('\nTest 5: Alice searching for Bob by username/ID...');
  const searchRes = await fetch(`${SERVER_URL}/api/users/search?q=${bobUsername}`, {
    headers: { 'Authorization': `Bearer ${user1Data.token}` }
  });
  const searchData = await searchRes.json();
  if (!searchData.users || searchData.users.length === 0) throw new Error('User search returned no results');
  const foundBob = searchData.users.find(u => u.username === bobUsername);
  if (!foundBob) throw new Error('Bob not found in search results');
  if (foundBob.relationship !== 'none') throw new Error(`Expected relationship 'none', got ${foundBob.relationship}`);
  console.log(`  ✓ Found Bob in search results with relationship '${foundBob.relationship}'`);

  // Test 6: Send Friend Request from Alice to Bob
  console.log('\nTest 6: Alice sending Friend Request to Bob...');
  const friendReqRes = await fetch(`${SERVER_URL}/api/friends/request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${user1Data.token}`
    },
    body: JSON.stringify({ target: bobUsername })
  });
  const friendReqData = await friendReqRes.json();
  if (!friendReqData.success) throw new Error('Failed to send friend request: ' + JSON.stringify(friendReqData));
  console.log(`  ✓ Friend request sent: ${friendReqData.message}`);

  // Test 7: Bob checking pending requests
  console.log('\nTest 7: Bob checking incoming friend requests...');
  const bobReqsRes = await fetch(`${SERVER_URL}/api/friends/requests`, {
    headers: { 'Authorization': `Bearer ${user2Data.token}` }
  });
  const bobReqsData = await bobReqsRes.json();
  const incomingReq = (bobReqsData.incoming || []).find(r => r.username === aliceUsername);
  if (!incomingReq) throw new Error('Incoming friend request from Alice not found in Bob\'s requests');
  console.log(`  ✓ Bob received incoming friend request from @${incomingReq.username} (Request ID: ${incomingReq.request_id})`);

  // Test 8: Bob accepting Alice's friend request
  console.log('\nTest 8: Bob accepting friend request...');
  const acceptRes = await fetch(`${SERVER_URL}/api/friends/accept`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${user2Data.token}`
    },
    body: JSON.stringify({ requestId: incomingReq.request_id })
  });
  const acceptData = await acceptRes.json();
  if (!acceptData.success) throw new Error('Failed to accept friend request: ' + JSON.stringify(acceptData));
  console.log(`  ✓ Friend request accepted successfully!`);

  // Test 9: Verify both users are in each other's accepted friends list
  console.log('\nTest 9: Verifying mutual accepted friends list...');
  const aliceFriends = await (await fetch(`${SERVER_URL}/api/friends`, { headers: { 'Authorization': `Bearer ${user1Data.token}` } })).json();
  const bobFriends = await (await fetch(`${SERVER_URL}/api/friends`, { headers: { 'Authorization': `Bearer ${user2Data.token}` } })).json();
  
  if (!aliceFriends.friends.some(f => f.username === bobUsername)) throw new Error('Bob not found in Alice\'s friends list');
  if (!bobFriends.friends.some(f => f.username === aliceUsername)) throw new Error('Alice not found in Bob\'s friends list');
  console.log(`  ✓ Alice has friend: @${aliceFriends.friends[0].username}`);
  console.log(`  ✓ Bob has friend: @${bobFriends.friends[0].username}`);

  // Test 10: Anonymous General Chat Verification
  console.log('\nTest 10: Verifying Anonymous General Chat behavior...');
  const chanRes = await fetch(`${SERVER_URL}/api/channels`);
  const chanData = await chanRes.json();
  const generalChan = chanData.channels.find(c => c.id === 'chan_general' || c.name === 'general');
  if (!generalChan) throw new Error('General channel not found');

  const socketAlice = io(SERVER_URL);
  const socketBob = io(SERVER_URL);

  await new Promise((resolve, reject) => {
    let count = 0;
    const check = () => { count++; if (count === 2) resolve(); };
    socketAlice.on('connect', check);
    socketBob.on('connect', check);
    setTimeout(() => reject(new Error('Socket connection timed out')), 5000);
  });

  socketAlice.emit('authenticate', user1Data.token);
  socketBob.emit('authenticate', user2Data.token);
  await new Promise(r => setTimeout(r, 400));

  socketAlice.emit('join_room', generalChan.id);
  socketBob.emit('join_room', generalChan.id);
  await new Promise(r => setTimeout(r, 300));

  const anonMsgPromise = new Promise((resolve, reject) => {
    socketBob.on('new_message', (msg) => {
      if (msg.room_id === generalChan.id && msg.content.includes('Anonymous check')) {
        resolve(msg);
      }
    });
    setTimeout(() => reject(new Error('General chat message reception timed out')), 5000);
  });

  socketAlice.emit('send_message', {
    room_type: 'channel',
    room_id: generalChan.id,
    content: 'Anonymous check in general chat!',
    message_type: 'text'
  });

  const receivedAnonMsg = await anonMsgPromise;
  console.log(`  ✓ Bob received message in General Chat:`, {
    content: receivedAnonMsg.content,
    sender_display_name: receivedAnonMsg.sender_display_name,
    sender_username: receivedAnonMsg.sender_username,
    sender_avatar_color: receivedAnonMsg.sender_avatar_color
  });

  if (receivedAnonMsg.sender_display_name !== 'Anonymous' || receivedAnonMsg.sender_username !== 'anonymous') {
    throw new Error(`Expected sender to be 'Anonymous' in general chat, got ${receivedAnonMsg.sender_display_name}`);
  }
  console.log(`  ✓ Verified General Chat sender is 100% masked as 'Anonymous'!`);

  // Test 11: Direct Messaging between Accepted Friends
  console.log('\nTest 11: 1-on-1 Direct Messaging between Friends...');
  const dmRoomId = [user1Data.user.id, user2Data.user.id].sort().join('_');
  socketAlice.emit('join_room', `dm_${dmRoomId}`);
  socketBob.emit('join_room', `dm_${dmRoomId}`);
  await new Promise(r => setTimeout(r, 300));

  const dmPromise = new Promise((resolve, reject) => {
    socketAlice.on('new_message', (msg) => {
      if (msg.room_type === 'direct' && msg.content.includes('Hello Alice my friend')) {
        resolve(msg);
      }
    });
    setTimeout(() => reject(new Error('DM reception timed out')), 5000);
  });

  socketBob.emit('send_message', {
    room_type: 'direct',
    room_id: `dm_${dmRoomId}`,
    recipient_id: user1Data.user.id,
    content: 'Hello Alice my friend! Private DM confirmed 💬',
    message_type: 'text'
  });

  const receivedDm = await dmPromise;
  console.log(`  ✓ Alice received private DM from friend: "${receivedDm.content}"`);

  // Cleanup: Delete test data and disconnect
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
