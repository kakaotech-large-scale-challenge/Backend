// data/redisDataLayer.js
const redisClient = require('../utils/redisClient'); // client와 connectRedis 대신 redisClient 인스턴스
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { S3Client, DeleteObjectCommand} = require('@aws-sdk/client-s3');

// AWS S3 설정
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME;

// init 함수에서 connectRedis 대신 redisClient.connect() 사용
async function init() {
  await redisClient.connect();
}

// User 관련
async function createUser({ name, email, passwordHash, encryptedEmail, profileImage = '' }) {
  await init();
  const userId = uuidv4();
  await redisClient.client.hSet(`user:${userId}`, {
    name, 
    email, 
    encryptedEmail: encryptedEmail || '',
    passwordHash,
    profileImage,
    createdAt: Date.now().toString(),
    lastActive: Date.now().toString()
  });

  // email -> userId 매핑
  await redisClient.client.set(`email_to_userid:${email}`, userId);
  return userId;
}

async function getUserById(userId) {
  await init();
  const user = await redisClient.client.hGetAll(`user:${userId}`);
  if (!user || Object.keys(user).length === 0) return null;
  return {
    id: userId,
    name: user.name,
    email: user.email,
    encryptedEmail: user.encryptedEmail,
    passwordHash: user.passwordHash,
    profileImage: user.profileImage,
    createdAt: new Date(parseInt(user.createdAt, 10)),
    lastActive: new Date(parseInt(user.lastActive, 10))
  };
}

async function findUserByEmail(email) {
  await init();
  const userId = await redisClient.client.get(`email_to_userid:${email}`);
  if (!userId) return null;
  return getUserById(userId);
}

async function updateUser(userId, updates) {
  await init();
  const fields = {};
  for (const key in updates) {
    fields[key] = typeof updates[key] === 'string' ? updates[key] : String(updates[key]);
  }
  await redisClient.client.hSet(`user:${userId}`, fields);
}

async function updateUserLastActive(userId) {
  await updateUser(userId, { lastActive: Date.now().toString() });
}

async function deleteUser(userId) {
  await init();
  const user = await getUserById(userId);
  if (!user) return;
  // email -> userId 매핑 제거
  await redisClient.client.del(`email_to_userid:${user.email}`);
  await redisClient.client.del(`user:${userId}`);
}

// Room 관련
async function createRoom(name, creatorUserId, password = null) {
    await init();
    const roomId = uuidv4();
    const hasPassword = !!password;
    const roomData = {
      name,
      creator: creatorUserId,
      hasPassword: hasPassword ? '1' : '0',
      createdAt: Date.now().toString()
    };
  
    if (hasPassword) {
      const salt = await bcrypt.genSalt(10);
      const hashed = await bcrypt.hash(password, salt);
      roomData.password = hashed;
    }
  
    await redisClient.client.hSet(`room:${roomId}`, roomData);
    await redisClient.client.sAdd(`room:${roomId}:participants`, creatorUserId);
  
    // 모든 방 ID를 관리하는 set에 추가
    await redisClient.client.sAdd('room:all', roomId);
  
    return roomId;
}

async function getAllRoomIds() {
    await init();
    return redisClient.client.sMembers('room:all');
}

async function getRoomById(roomId) {
  await init();
  const room = await redisClient.client.hGetAll(`room:${roomId}`);
  if (!room || Object.keys(room).length === 0) return null;
  const participants = await redisClient.client.sMembers(`room:${roomId}:participants`);
  return {
    id: roomId,
    name: room.name,
    creator: room.creator,
    hasPassword: room.hasPassword === '1',
    createdAt: new Date(parseInt(room.createdAt, 10)),
    participants
  };
}

async function addParticipant(roomId, userId) {
  await init();
  await redisClient.client.sAdd(`room:${roomId}:participants`, userId);
}

async function removeParticipant(roomId, userId) {
  await init();
  await redisClient.client.sRem(`room:${roomId}:participants`, userId);
}

async function checkRoomPassword(roomId, password) {
  await init();
  const hashed = await redisClient.client.hGet(`room:${roomId}`, 'password');
  if (!hashed) return true; // no password
  return bcrypt.compare(password, hashed);
}

// Message 관련
async function createMessage(roomId, { type, content, sender, fileId, aiType }) {
  await init();
  const messageId = uuidv4();
  const timestamp = Date.now();
  console.log(roomId, type, content, sender, fileId, aiType);
  const msgData = {
    room: roomId,
    type: type,
    content: content || '',
    sender: sender || '',
    timestamp: timestamp.toString(),
    isDeleted: '0'
  };

  if (type === 'file' && fileId) {
    msgData.file = fileId;
  }

  if (type === 'ai' && aiType) {
    msgData.aiType = aiType;
  }

  await redisClient.client.hSet(`message:${messageId}`, msgData);
  await redisClient.client.zAdd(`room:${roomId}:messages`, {
    score: timestamp,
    value: messageId
  });

  return messageId;
}

async function getMessage(messageId) {
  await init();
  const m = await redisClient.client.hGetAll(`message:${messageId}`);
  if (!m || Object.keys(m).length === 0) return null;

  return {
    _id: messageId,
    room: m.room,
    type: m.type,
    content: m.content,
    sender: m.sender,
    file: m.file || null,
    aiType: m.aiType || null,
    timestamp: new Date(parseInt(m.timestamp, 10)),
    isDeleted: m.isDeleted === '1'
  };
}

async function getMessagesForRoom(roomId, beforeTimestamp = null, limit = 30) {
  await init();
  const maxScore = beforeTimestamp ? (beforeTimestamp - 1) : '+inf';
  const messageIds = await redisClient.client.zRangeByScore(`room:${roomId}:messages`, '-inf', maxScore, {
    REV: true,
    LIMIT: { offset: 0, count: limit + 1 }
  });

  const hasMore = messageIds.length > limit;
  const resultIds = messageIds.slice(0, limit);

  const messages = [];
  for (const mid of resultIds) {
    const msg = await getMessage(mid);
    if (msg) messages.push(msg);
  }

  messages.sort((a,b) => a.timestamp - b.timestamp);
  return { messages, hasMore, oldestTimestamp: messages[0]?.timestamp.getTime() || null };
}

async function updateMessage(messageId, fields) {
  await init();
  const updateData = {};
  for (const k in fields) {
    updateData[k] = String(fields[k]);
  }
  await redisClient.client.hSet(`message:${messageId}`, updateData);
}

async function markMessagesAsRead(userId, roomId, messageIds) {
  await init();
  for (const mid of messageIds) {
    const readersKey = `message:${mid}:readers`;
    const isMember = await redisClient.client.sIsMember(readersKey, userId);
    if (!isMember) {
      await redisClient.client.sAdd(readersKey, userId);
    }
  }
}

async function addReaction(messageId, emoji, userId) {
  await init();
  const key = `message:${messageId}:reactions:${emoji}`;
  await redisClient.client.sAdd(key, userId);
}

async function removeReaction(messageId, emoji, userId) {
  await init();
  const key = `message:${messageId}:reactions:${emoji}`;
  await redisClient.client.sRem(key, userId);
}

async function getReactions(messageId) {
  await init();
  const reactions = {};
  const pattern = `message:${messageId}:reactions:*`;
  let cursor = '0';
  do {
    const reply = await redisClient.client.scan(cursor, { MATCH: pattern, COUNT: 100 });
    cursor = reply.cursor;
    for (const key of reply.keys) {
      const emoji = key.split(':').pop();
      const users = await redisClient.client.sMembers(key);
      reactions[emoji] = users;
    }
  } while (cursor !== '0');

  return reactions;
}

// File 관련
async function createFile({ filename, originalname, mimetype, size, userId, path }) {
  await init();
  const fileId = uuidv4();
  try{
    await redisClient.client.hSet(`file:${fileId}`, {
      filename,
      originalname,
      mimetype,
      size: String(size),
      user: userId,
      path,
      uploadDate: Date.now().toString()
    });
    return fileId;
  } catch(error){
    console.error(`파일 정보 저장 실패: ${fileId}`, error);
    // S3에 업로드된 파일을 삭제하여 데이터 일관성을 유지
    try {
      await s3.send(new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: filename,
      }));
      console.log(`S3 파일 롤백 성공: ${filename}`);
    } catch (rollbackError) {
      console.error(`S3 파일 롤백 실패: ${filename}`, rollbackError);
    }
  }

}

async function getFile(fileId) {
  await init();
  const f = await redisClient.client.hGetAll(`file:${fileId}`);
  if (!f || Object.keys(f).length === 0) return null;
  return {
    _id: fileId,
    filename: f.filename,
    originalname: f.originalname,
    mimetype: f.mimetype,
    size: parseInt(f.size, 10),
    user: f.user,
    path: f.path,
    uploadDate: new Date(parseInt(f.uploadDate, 10))
  };
}

async function deleteFile(fileId) {
  await init();
  const file = await getFile(fileId);
  if (!file) return;

  // S3에서 파일 삭제
  const deleteParams = {
    Bucket: BUCKET_NAME,
    Key: file.filename,
  };
  try {
    await s3.send(new DeleteObjectCommand(deleteParams));
    console.log(`S3 파일 삭제 성공: ${file.filename}`);
  } catch (error) {
    console.error(`S3 파일 삭제 실패: ${file.filename}`, error);
    throw new Error('S3 파일 삭제 실패'); // 실패 시 종료
  }

  // Redis에서 파일 정보 삭제
  await redisClient.client.del(`file:${fileId}`);
}

module.exports = {
  createUser, getUserById, findUserByEmail, updateUser, updateUserLastActive, deleteUser,
  createRoom, getRoomById, addParticipant, removeParticipant, checkRoomPassword,
  createMessage, getMessage, getMessagesForRoom, updateMessage, markMessagesAsRead,
  addReaction, removeReaction, getReactions, getAllRoomIds,
  createFile, getFile, deleteFile
};