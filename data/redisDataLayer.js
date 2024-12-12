// data/redisDataLayer.js
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { S3Client, DeleteObjectCommand} = require('@aws-sdk/client-s3');
const redisClient = require('../utils/redisClient');

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
// async function init() {
//   await redisClient.connect();
// }

// User 관련
async function createUser({ name, email, passwordHash, encryptedEmail, profileImage = '' }) {
    const userId = uuidv4();
    const userData = {
        name,
        email,
        encryptedEmail: encryptedEmail || '',
        passwordHash,
        profileImage,
        createdAt: Date.now().toString(),
        lastActive: Date.now().toString()
    };

    await redisClient.hSet(`user:${userId}`, userData);
    await redisClient.set(`email_to_userid:${email}`, userId);
    return userId;
}

async function getUserById(userId) {
    const user = await redisClient.hGetAll(`user:${userId}`);
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
    const userId = await redisClient.get(`email_to_userid:${email}`);
    if (!userId) return null;
    return getUserById(userId);
}

async function updateUser(userId, updates) {
    const fields = Object.entries(updates).reduce((acc, [key, value]) => {
        acc[key] = typeof value === 'string' ? value : String(value);
        return acc;
    }, {});
    
    await redisClient.hSet(`user:${userId}`, fields);
}

async function updateUserLastActive(userId) {
    await updateUser(userId, { lastActive: Date.now().toString() });
}

async function deleteUser(userId) {
    const user = await getUserById(userId);
    if (!user) return;
    
    await Promise.all([
        redisClient.del(`email_to_userid:${user.email}`),
        redisClient.del(`user:${userId}`)
    ]);
}

// Room 관련
async function createRoom(name, creatorUserId, password = null) {
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
        roomData.password = await bcrypt.hash(password, salt);
    }

    await Promise.all([
        redisClient.hSet(`room:${roomId}`, roomData),
        redisClient.sAdd(`room:${roomId}:participants`, creatorUserId), // 단일 값 추가
        redisClient.sAdd('room:all', roomId) // 단일 값 추가
    ]);

    return roomId;
}

async function getAllRoomIds() {
    return redisClient.sMembers('room:all');
}

async function getRoomById(roomId) {
    const [room, participants] = await Promise.all([
        redisClient.hGetAll(`room:${roomId}`),
        redisClient.sMembers(`room:${roomId}:participants`) // sMembers 사용
    ]);

    if (!room || Object.keys(room).length === 0) return null;
    
    return {
        id: roomId,
        name: room.name,
        creator: room.creator,
        hasPassword: room.hasPassword === '1',
        createdAt: new Date(parseInt(room.createdAt, 10)),
        participants: participants || []
    };
}

async function addParticipant(roomId, userId) {
    return redisClient.sAdd(`room:${roomId}:participants`, userId);
}

async function removeParticipant(roomId, userId) {
    return redisClient.sRem(`room:${roomId}:participants`, userId);
}

async function checkRoomPassword(roomId, password) {
    const hashed = await redisClient.hGet(`room:${roomId}`, 'password');
    if (!hashed) return true;
    return bcrypt.compare(password, hashed);
}

async function createMessage(roomId, { type, content, sender, fileId, aiType }) {
    try {
        const messageId = uuidv4();
        const timestamp = Date.now();
        
        const msgData = {
            room: roomId,
            type,
            content: content || '',
            sender: sender || '',
            timestamp: timestamp.toString(),
            isDeleted: '0',
            ...(type === 'file' && fileId ? { file: fileId } : {}),
            ...(type === 'ai' && aiType ? { aiType } : {})
        };

        const messagesKey = `room:${roomId}:messages`;
        const keyType = await redisClient.cluster.type(messagesKey);
        if (keyType !== 'zset' && keyType !== 'none') {
            await redisClient.del(messagesKey);
        }

        await Promise.all([
            redisClient.hSet(`message:${messageId}`, msgData),
            redisClient.cluster.zadd(messagesKey, timestamp, messageId)  // 수정된 부분
        ]);

        return messageId;
    } catch (error) {
        console.error('Create message error:', error, {
            roomId,
            type,
            sender
        });
        throw error;
    }
}

async function getMessagesForRoom(roomId, beforeTimestamp = null, limit = 30) {
    try {
        const messagesKey = `room:${roomId}:messages`;
        const keyType = await redisClient.cluster.type(messagesKey);
        
        // 기존 데이터가 잘못된 타입이면 초기화
        if (keyType !== 'zset' && keyType !== 'none') {
            await redisClient.del(messagesKey);
            return {
                messages: [],
                hasMore: false,
                oldestTimestamp: null
            };
        }

        const maxScore = beforeTimestamp || '+inf';
        const messageIds = await redisClient.cluster.zrevrangebyscore(
            messagesKey,
            maxScore,
            '-inf',
            'LIMIT', 0, limit + 1
        );

        if (!messageIds || messageIds.length === 0) {
            return {
                messages: [],
                hasMore: false,
                oldestTimestamp: null
            };
        }

        const hasMore = messageIds.length > limit;
        const resultIds = messageIds.slice(0, limit);

        const messagePromises = resultIds.map(id => getMessage(id));
        const messages = await Promise.all(messagePromises);
        const validMessages = messages.filter(Boolean);
        
        validMessages.sort((a, b) => a.timestamp - b.timestamp);
        
        return {
            messages: validMessages,
            hasMore,
            oldestTimestamp: validMessages[0]?.timestamp.getTime() || null
        };
    } catch (error) {
        console.error('Get messages error:', error, {
            roomId,
            beforeTimestamp,
            limit
        });
        return {
            messages: [],
            hasMore: false,
            oldestTimestamp: null
        };
    }
}

async function getMessage(messageId) {
    try {
        const message = await redisClient.hGetAll(`message:${messageId}`);
        if (!message || Object.keys(message).length === 0) return null;

        return {
            _id: messageId,
            room: message.room,
            type: message.type,
            content: message.content,
            sender: message.sender,
            file: message.file || null,
            aiType: message.aiType || null,
            timestamp: new Date(parseInt(message.timestamp, 10)),
            isDeleted: message.isDeleted === '1'
        };
    } catch (error) {
        console.error('Get message error:', error, { messageId });
        return null;
    }
}

async function updateMessage(messageId, fields) {
    const updateData = Object.entries(fields).reduce((acc, [key, value]) => {
        acc[key] = String(value);
        return acc;
    }, {});
    
    await redisClient.hSet(`message:${messageId}`, updateData);
}

async function markMessagesAsRead(userId, roomId, messageIds) {
    for (const messageId of messageIds) {
        const readers = await redisClient.get(`message:${messageId}:readers`) || [];
        if (!readers.includes(userId)) {
            readers.push(userId);
            await redisClient.set(`message:${messageId}:readers`, readers);
        }
    }
}

async function addReaction(messageId, emoji, userId) {
    const reactions = await redisClient.get(`message:${messageId}:reactions`) || {};
    if (!reactions[emoji]) reactions[emoji] = [];
    if (!reactions[emoji].includes(userId)) {
        reactions[emoji].push(userId);
        await redisClient.set(`message:${messageId}:reactions`, reactions);
    }
}

async function removeReaction(messageId, emoji, userId) {
    const reactions = await redisClient.get(`message:${messageId}:reactions`) || {};
    if (reactions[emoji]) {
        reactions[emoji] = reactions[emoji].filter(id => id !== userId);
        if (reactions[emoji].length === 0) delete reactions[emoji];
        await redisClient.set(`message:${messageId}:reactions`, reactions);
    }
}

async function getReactions(messageId) {
    return await redisClient.get(`message:${messageId}:reactions`) || {};
}

// File 관련
async function createFile({ filename, originalname, mimetype, size, userId, path }) {
//   await init();
  const fileId = uuidv4();
  try{
    await redisClient.hSet(`file:${fileId}`, {
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
    const file = await redisClient.hGetAll(`file:${fileId}`);
    if (!file || Object.keys(file).length === 0) return null;

    return {
        _id: fileId,
        filename: file.filename,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: parseInt(file.size, 10),
        user: file.user,
        path: file.path,
        uploadDate: new Date(parseInt(file.uploadDate, 10))
    };
}

async function deleteFile(fileId) {
//   await init();
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
  await redisClient.cluster.del(`file:${fileId}`);
}

module.exports = {
    createUser, getUserById, findUserByEmail, updateUser, updateUserLastActive, deleteUser,
    createRoom, getRoomById, addParticipant, removeParticipant, checkRoomPassword,
    createMessage, getMessage, getMessagesForRoom, updateMessage, markMessagesAsRead,
    addReaction, removeReaction, getReactions, getAllRoomIds,
    createFile, getFile, deleteFile
};

// const bcrypt = require('bcryptjs');
// const { v4: uuidv4 } = require('uuid');
// const { S3Client, DeleteObjectCommand} = require('@aws-sdk/client-s3');
// const redisClient = require('../utils/redisClient');

// const s3 = new S3Client({
//   region: process.env.AWS_REGION,
//   credentials: {
//     accessKeyId: process.env.AWS_ACCESS_KEY_ID,
//     secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
//   },
// });

// const BUCKET_NAME = process.env.S3_BUCKET_NAME;

// // User 관련
// async function createUser({ name, email, passwordHash, encryptedEmail, profileImage = '' }) {
//     const userId = uuidv4();
//     const userData = {
//         name,
//         email,
//         encryptedEmail: encryptedEmail || '',
//         passwordHash,
//         profileImage,
//         createdAt: Date.now().toString(),
//         lastActive: Date.now().toString()
//     };

//     await redisClient.hSet(`user:${userId}`, userData);
//     await redisClient.set(`email_to_userid:${email}`, userId);
//     return userId;
// }

// async function getUserById(userId) {
//     const user = await redisClient.hGetAll(`user:${userId}`);
//     if (!user || Object.keys(user).length === 0) return null;
    
//     return {
//         id: userId,
//         name: user.name,
//         email: user.email,
//         encryptedEmail: user.encryptedEmail,
//         passwordHash: user.passwordHash,
//         profileImage: user.profileImage,
//         createdAt: new Date(parseInt(user.createdAt, 10)),
//         lastActive: new Date(parseInt(user.lastActive, 10))
//     };
// }

// async function findUserByEmail(email) {
//     const userId = await redisClient.get(`email_to_userid:${email}`);
//     if (!userId) return null;
//     return getUserById(userId);
// }

// async function updateUser(userId, updates) {
//     const fields = Object.entries(updates).reduce((acc, [key, value]) => {
//         acc[key] = typeof value === 'string' ? value : String(value);
//         return acc;
//     }, {});
    
//     await redisClient.hSet(`user:${userId}`, fields);
// }

// async function updateUserLastActive(userId) {
//     await updateUser(userId, { lastActive: Date.now().toString() });
// }

// async function deleteUser(userId) {
//     const user = await getUserById(userId);
//     if (!user) return;
    
//     await Promise.all([
//         redisClient.cluster.del(`email_to_userid:${user.email}`),
//         redisClient.cluster.del(`user:${userId}`)
//     ]);
// }

// // Room 관련
// async function createRoom(name, creatorUserId, password = null) {
//     const roomId = uuidv4();
//     const hasPassword = !!password;
//     const roomData = {
//         name,
//         creator: creatorUserId,
//         hasPassword: hasPassword ? '1' : '0',
//         createdAt: Date.now().toString()
//     };

//     if (hasPassword) {
//         const salt = await bcrypt.genSalt(10);
//         roomData.password = await bcrypt.hash(password, salt);
//     }

//     await Promise.all([
//         redisClient.hSet(`room:${roomId}`, roomData),
//         redisClient.sAdd(`room:${roomId}:participants`, creatorUserId),
//         redisClient.sAdd('room:all', roomId)
//     ]);

//     return roomId;
// }

// async function getAllRoomIds() {
//     return redisClient.sMembers('room:all');
// }

// async function getRoomById(roomId) {
//     const [room, participants] = await Promise.all([
//         redisClient.hGetAll(`room:${roomId}`),
//         redisClient.sMembers(`room:${roomId}:participants`)
//     ]);

//     if (!room || Object.keys(room).length === 0) return null;
    
//     return {
//         id: roomId,
//         name: room.name,
//         creator: room.creator,
//         hasPassword: room.hasPassword === '1',
//         createdAt: new Date(parseInt(room.createdAt, 10)),
//         participants: participants || []
//     };
// }

// async function addParticipant(roomId, userId) {
//     return redisClient.sAdd(`room:${roomId}:participants`, userId);
// }

// async function removeParticipant(roomId, userId) {
//     return redisClient.cluster.sRem(`room:${roomId}:participants`, userId);
// }

// async function checkRoomPassword(roomId, password) {
//     const hashed = await redisClient.cluster.hGet(`room:${roomId}`, 'password');
//     if (!hashed) return true;
//     return bcrypt.compare(password, hashed);
// }

// async function createMessage(roomId, { type, content, sender, fileId, aiType }) {
//     try {
//         const messageId = uuidv4();
//         const timestamp = Date.now();
        
//         const msgData = {
//             room: roomId,
//             type,
//             content: content || '',
//             sender: sender || '',
//             timestamp: timestamp.toString(),
//             isDeleted: '0',
//             ...(type === 'file' && fileId ? { file: fileId } : {}),
//             ...(type === 'ai' && aiType ? { aiType } : {})
//         };

//         const messagesKey = `room:${roomId}:messages`;
//         const keyType = await redisClient.cluster.type(messagesKey);
//         if (keyType !== 'zset' && keyType !== 'none') {
//             await redisClient.cluster.del(messagesKey);
//         }

//         await Promise.all([
//             redisClient.hSet(`message:${messageId}`, msgData),
//             redisClient.cluster.zAdd(messagesKey, { score: timestamp, value: messageId })
//         ]);

//         return messageId;
//     } catch (error) {
//         console.error('Create message error:', error);
//         throw error;
//     }
// }

// async function getMessagesForRoom(roomId, beforeTimestamp = null, limit = 30) {
//     try {
//         const messagesKey = `room:${roomId}:messages`;
//         const keyType = await redisClient.cluster.type(messagesKey);
        
//         if (keyType !== 'zset' && keyType !== 'none') {
//             await redisClient.cluster.del(messagesKey);
//             return {
//                 messages: [],
//                 hasMore: false,
//                 oldestTimestamp: null
//             };
//         }

//         const maxScore = beforeTimestamp || '+inf';
//         const messageIds = await redisClient.cluster.zRangeByScore(
//             messagesKey,
//             maxScore,
//             '-inf',
//             'LIMIT', 0, limit + 1
//         );

//         if (!messageIds || messageIds.length === 0) {
//             return {
//                 messages: [],
//                 hasMore: false,
//                 oldestTimestamp: null
//             };
//         }

//         const hasMore = messageIds.length > limit;
//         const resultIds = messageIds.slice(0, limit);

//         const messagePromises = resultIds.map(id => getMessage(id));
//         const messages = await Promise.all(messagePromises);
//         const validMessages = messages.filter(Boolean);
        
//         validMessages.sort((a, b) => a.timestamp - b.timestamp);
        
//         return {
//             messages: validMessages,
//             hasMore,
//             oldestTimestamp: validMessages[0]?.timestamp.getTime() || null
//         };
//     } catch (error) {
//         console.error('Get messages error:', error);
//         return {
//             messages: [],
//             hasMore: false,
//             oldestTimestamp: null
//         };
//     }
// }

// async function getMessage(messageId) {
//     try {
//         const message = await redisClient.hGetAll(`message:${messageId}`);
//         if (!message || Object.keys(message).length === 0) return null;

//         return {
//             _id: messageId,
//             room: message.room,
//             type: message.type,
//             content: message.content,
//             sender: message.sender,
//             file: message.file || null,
//             aiType: message.aiType || null,
//             timestamp: new Date(parseInt(message.timestamp, 10)),
//             isDeleted: message.isDeleted === '1'
//         };
//     } catch (error) {
//         console.error('Get message error:', error);
//         return null;
//     }
// }

// async function updateMessage(messageId, fields) {
//     const updateData = Object.entries(fields).reduce((acc, [key, value]) => {
//         acc[key] = String(value);
//         return acc;
//     }, {});
    
//     await redisClient.hSet(`message:${messageId}`, updateData);
// }

// async function markMessagesAsRead(userId, roomId, messageIds) {
//     for (const messageId of messageIds) {
//         const readers = await redisClient.get(`message:${messageId}:readers`) || [];
//         if (!readers.includes(userId)) {
//             readers.push(userId);
//             await redisClient.set(`message:${messageId}:readers`, readers);
//         }
//     }
// }

// async function addReaction(messageId, emoji, userId) {
//     const reactions = await redisClient.get(`message:${messageId}:reactions`) || {};
//     if (!reactions[emoji]) reactions[emoji] = [];
//     if (!reactions[emoji].includes(userId)) {
//         reactions[emoji].push(userId);
//         await redisClient.set(`message:${messageId}:reactions`, reactions);
//     }
// }

// async function removeReaction(messageId, emoji, userId) {
//     const reactions = await redisClient.get(`message:${messageId}:reactions`) || {};
//     if (reactions[emoji]) {
//         reactions[emoji] = reactions[emoji].filter(id => id !== userId);
//         if (reactions[emoji].length === 0) delete reactions[emoji];
//         await redisClient.set(`message:${messageId}:reactions`, reactions);
//     }
// }

// async function getReactions(messageId) {
//     return await redisClient.get(`message:${messageId}:reactions`) || {};
// }

// // File 관련
// async function createFile({ filename, originalname, mimetype, size, userId, path }) {
//     const fileId = uuidv4();
//     try {
//         await redisClient.hSet(`file:${fileId}`, {
//             filename,
//             originalname,
//             mimetype,
//             size: String(size),
//             user: userId,
//             path,
//             uploadDate: Date.now().toString()
//         });
//         return fileId;
//     } catch(error) {
//         console.error(`파일 정보 저장 실패: ${fileId}`, error);
//         try {
//             await s3.send(new DeleteObjectCommand({
//                 Bucket: BUCKET_NAME,
//                 Key: filename,
//             }));
//             console.log(`S3 파일 롤백 성공: ${filename}`);
//         } catch (rollbackError) {
//             console.error(`S3 파일 롤백 실패: ${filename}`, rollbackError);
//         }
//         throw error;
//     }
// }

// async function getFile(fileId) {
//     const file = await redisClient.hGetAll(`file:${fileId}`);
//     if (!file || Object.keys(file).length === 0) return null;

//     return {
//         _id: fileId,
//         filename: file.filename,
//         originalname: file.originalname,
//         mimetype: file.mimetype,
//         size: parseInt(file.size, 10),
//         user: file.user,
//         path: file.path,
//         uploadDate: new Date(parseInt(file.uploadDate, 10))
//     };
// }

// async function deleteFile(fileId) {
//     const file = await getFile(fileId);
//     if (!file) return;

//     const deleteParams = {
//         Bucket: BUCKET_NAME,
//         Key: file.filename,
//     };
    
//     try {
//         await s3.send(new DeleteObjectCommand(deleteParams));
//         console.log(`S3 파일 삭제 성공: ${file.filename}`);
//     } catch (error) {
//         console.error(`S3 파일 삭제 실패: ${file.filename}`, error);
//         throw new Error('S3 파일 삭제 실패');
//     }

//     await redisClient.cluster.del(`file:${fileId}`);
// }

// module.exports = {
//     createUser, getUserById, findUserByEmail, updateUser, updateUserLastActive, deleteUser,
//     createRoom, getRoomById, addParticipant, removeParticipant, checkRoomPassword,
//     createMessage, getMessage, getMessagesForRoom, updateMessage, markMessagesAsRead,
//     addReaction, removeReaction, getReactions, getAllRoomIds,
//     createFile, getFile, deleteFile
// };