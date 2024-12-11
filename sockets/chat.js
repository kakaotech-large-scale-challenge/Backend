const redisDataLayer = require('../data/redisDataLayer');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/keys');
const redisClient = require('../utils/redisClient');
const SessionService = require('../services/sessionService');
const aiService = require('../services/aiService');

module.exports = function (io) {
  const connectedUsers = new Map();
  const streamingSessions = new Map();
  const userRooms = new Map();
  const messageQueues = new Map();
  const messageLoadRetries = new Map();
  const BATCH_SIZE = 30;
  const LOAD_DELAY = 300;
  const MAX_RETRIES = 3;
  const MESSAGE_LOAD_TIMEOUT = 10000;
  const RETRY_DELAY = 2000;
  const DUPLICATE_LOGIN_TIMEOUT = 10000;

  const logDebug = (action, data) => {
    console.debug(`[Socket.IO] ${action}:`, {
      ...data,
      timestamp: new Date().toISOString()
    });
  };

  const loadMessages = async (socket, roomId, before, limit = BATCH_SIZE) => {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Message loading timed out'));
      }, MESSAGE_LOAD_TIMEOUT);
    });
  
    try {
      const beforeTimestamp = before ? new Date(before).getTime() : null;
      const result = await Promise.race([
        redisDataLayer.getMessagesForRoom(roomId, beforeTimestamp, limit),
        timeoutPromise
      ]);
  
      const { messages, hasMore, oldestTimestamp } = result;
  
      // sender 정보 로딩 추가
      const enhancedMessages = await Promise.all(messages.map(async (msg) => {
        // sender 정보 로딩
        if (msg.sender && msg.sender !== 'system') {
          const senderUser = await redisDataLayer.getUserById(msg.sender);
          msg.sender = senderUser ? {
            _id: senderUser.id,
            name: senderUser.name,
            email: senderUser.email,
            profileImage: senderUser.profileImage
          } : { _id: 'unknown', name: '알 수 없음', email: '', profileImage: '' };
        }
  
        // file 정보 로딩 (필요한 경우)
        if (msg.type === 'file' && msg.file) {
          const file = await redisDataLayer.getFile(msg.file);
          if (file) {
            msg.file = {
              _id: file._id,
              filename: file.filename,
              originalname: file.originalname,
              mimetype: file.mimetype,
              size: file.size
            };
          }
        }
  
        return msg;
      }));
  
      // 읽음 상태 업데이트
      if (messages.length > 0 && socket.user) {
        const messageIds = messages.map(msg => msg._id);
        await redisDataLayer.markMessagesAsRead(socket.user.id, roomId, messageIds);
      }
  
      return { 
        messages: enhancedMessages, 
        hasMore, 
        oldestTimestamp: oldestTimestamp ? new Date(oldestTimestamp) : null 
      };
    } catch (error) {
      if (error.message === 'Message loading timed out') {
        logDebug('message load timeout', { roomId, before, limit });
      } else {
        console.error('Load messages error:', {
          error: error.message,
          stack: error.stack,
          roomId,
          before,
          limit,
        });
      }
      throw error;
    }
  };

  const loadMessagesWithRetry = async (socket, roomId, before, retryCount = 0) => {
    const retryKey = `${roomId}:${socket.user.id}`;
    try {
      if (messageLoadRetries.get(retryKey) >= MAX_RETRIES) {
        throw new Error('최대 재시도 횟수를 초과했습니다.');
      }

      const result = await loadMessages(socket, roomId, before);
      messageLoadRetries.delete(retryKey);
      return result;
    } catch (error) {
      const currentRetries = messageLoadRetries.get(retryKey) || 0;
      if (currentRetries < MAX_RETRIES) {
        messageLoadRetries.set(retryKey, currentRetries + 1);
        const delay = Math.min(RETRY_DELAY * Math.pow(2, currentRetries), 10000);

        logDebug('retrying message load', { roomId, retryCount: currentRetries + 1, delay });

        await new Promise(resolve => setTimeout(resolve, delay));
        return loadMessagesWithRetry(socket, roomId, before, currentRetries + 1);
      }

      messageLoadRetries.delete(retryKey);
      throw error;
    }
  };

  const handleDuplicateLogin = async (existingSocket, newSocket) => {
    try {
      existingSocket.emit('duplicate_login', {
        type: 'new_login_attempt',
        deviceInfo: newSocket.handshake.headers['user-agent'],
        ipAddress: newSocket.handshake.address,
        timestamp: Date.now()
      });

      return new Promise((resolve) => {
        setTimeout(async () => {
          try {
            existingSocket.emit('session_ended', {
              reason: 'duplicate_login',
              message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
            });
            existingSocket.disconnect(true);
            resolve();
          } catch (error) {
            console.error('Error during session termination:', error);
            resolve();
          }
        }, DUPLICATE_LOGIN_TIMEOUT);
      });
    } catch (error) {
      console.error('Duplicate login handling error:', error);
      throw error;
    }
  };

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      const sessionId = socket.handshake.auth.sessionId;

      if (!token || !sessionId) {
        return next(new Error('Authentication error'));
      }

      const decoded = jwt.verify(token, jwtSecret);
      if (!decoded?.user?.id) {
        return next(new Error('Invalid token'));
      }

      const existingSocketId = connectedUsers.get(decoded.user.id);
      if (existingSocketId) {
        const existingSocket = io.sockets.sockets.get(existingSocketId);
        if (existingSocket) {
          await handleDuplicateLogin(existingSocket, socket);
        }
      }

      const validationResult = await SessionService.validateSession(decoded.user.id, sessionId);
      if (!validationResult.isValid) {
        console.error('Session validation failed:', validationResult);
        return next(new Error(validationResult.message || 'Invalid session'));
      }

      const user = await redisDataLayer.getUserById(decoded.user.id);
      if (!user) {
        return next(new Error('User not found'));
      }

      socket.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        sessionId: sessionId,
        profileImage: user.profileImage
      };

      await SessionService.updateLastActivity(decoded.user.id);
      next();

    } catch (error) {
      console.error('Socket authentication error:', error);
      if (error.name === 'TokenExpiredError') {
        return next(new Error('Token expired'));
      }
      if (error.name === 'JsonWebTokenError') {
        return next(new Error('Invalid token'));
      }
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    logDebug('socket connected', {
      socketId: socket.id,
      userId: socket.user?.id,
      userName: socket.user?.name
    });

    if (socket.user) {
      const previousSocketId = connectedUsers.get(socket.user.id);
      if (previousSocketId && previousSocketId !== socket.id) {
        const previousSocket = io.sockets.sockets.get(previousSocketId);
        if (previousSocket) {
          previousSocket.emit('duplicate_login', {
            type: 'new_login_attempt',
            deviceInfo: socket.handshake.headers['user-agent'],
            ipAddress: socket.handshake.address,
            timestamp: Date.now()
          });

          setTimeout(() => {
            previousSocket.emit('session_ended', {
              reason: 'duplicate_login',
              message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
            });
            previousSocket.disconnect(true);
          }, DUPLICATE_LOGIN_TIMEOUT);
        }
      }
      connectedUsers.set(socket.user.id, socket.id);
    }

    socket.on('fetchPreviousMessages', async ({ roomId, before }) => {
      const queueKey = `${roomId}:${socket.user.id}`;

      try {
        if (!socket.user) throw new Error('Unauthorized');

        const room = await redisDataLayer.getRoomById(roomId);
        if (!room || !room.participants.includes(socket.user.id)) {
          throw new Error('채팅방 접근 권한이 없습니다.');
        }

        if (messageQueues.get(queueKey)) {
          logDebug('message load skipped - already loading', { roomId, userId: socket.user.id });
          return;
        }

        messageQueues.set(queueKey, true);
        socket.emit('messageLoadStart');

        const result = await loadMessagesWithRetry(socket, roomId, before);

        logDebug('previous messages loaded', {
          roomId,
          messageCount: result.messages.length,
          hasMore: result.hasMore,
          oldestTimestamp: result.oldestTimestamp,
        });

        socket.emit('previousMessagesLoaded', result);

      } catch (error) {
        console.error('Fetch previous messages error:', error);
        socket.emit('error', {
          type: 'LOAD_ERROR',
          message: error.message || '이전 메시지를 불러오는 중 오류가 발생했습니다.'
        });
      } finally {
        setTimeout(() => {
          messageQueues.delete(queueKey);
        }, LOAD_DELAY);
      }
    });

    socket.on('joinRoom', async (roomId) => {
      try {
        if (!socket.user) throw new Error('Unauthorized');

        const currentRoom = userRooms.get(socket.user.id);
        if (currentRoom === roomId) {
          logDebug('already in room', { userId: socket.user.id, roomId });
          socket.emit('joinRoomSuccess', { roomId });
          return;
        }

        if (currentRoom) {
          logDebug('leaving current room', { userId: socket.user.id, roomId: currentRoom });
          socket.leave(currentRoom);
          userRooms.delete(socket.user.id);
          socket.to(currentRoom).emit('userLeft', { userId: socket.user.id, name: socket.user.name });
        }

        // 방 정보 조회
        let room = await redisDataLayer.getRoomById(roomId);
        if (!room) {
          throw new Error('채팅방을 찾을 수 없습니다.');
        }

        // 해당 유저 참가자 목록에 추가
        if (!room.participants.includes(socket.user.id)) {
          await redisDataLayer.addParticipant(roomId, socket.user.id);
          room = await redisDataLayer.getRoomById(roomId);
        }

        socket.join(roomId);
        userRooms.set(socket.user.id, roomId);

        // 입장 메시지 생성
        const joinMsgId = await redisDataLayer.createMessage(roomId, {
          type: 'system',
          content: `${socket.user.name}님이 입장하였습니다.`,
          sender: 'system'
        });
        const joinMessage = await redisDataLayer.getMessage(joinMsgId);

        // 초기 메시지 로드
        const messageLoadResult = await loadMessages(socket, roomId);
        const { messages, hasMore, oldestTimestamp } = messageLoadResult;

        // participants 정보 로딩
        const participantsData = [];
        for (const pid of room.participants) {
          const pu = await redisDataLayer.getUserById(pid);
          if (pu) participantsData.push({ _id: pu.id, name: pu.name, email: pu.email, profileImage: pu.profileImage });
        }

        // 활성 스트리밍 메시지 조회
        const activeStreams = Array.from(streamingSessions.values())
          .filter(session => session.room === roomId)
          .map(session => ({
            _id: session.messageId,
            type: 'ai',
            aiType: session.aiType,
            content: session.content,
            timestamp: session.timestamp,
            isStreaming: true
          }));

        socket.emit('joinRoomSuccess', {
          roomId,
          participants: participantsData,
          messages,
          hasMore,
          oldestTimestamp,
          activeStreams
        });

        io.to(roomId).emit('message', joinMessage);
        io.to(roomId).emit('participantsUpdate', participantsData);

        logDebug('user joined room', {
          userId: socket.user.id,
          roomId,
          messageCount: messages.length,
          hasMore
        });

      } catch (error) {
        console.error('Join room error:', error);
        socket.emit('joinRoomError', {
          message: error.message || '채팅방 입장에 실패했습니다.'
        });
      }
    });

    socket.on('chatMessage', async (messageData) => {
      try {
        if (!socket.user) throw new Error('Unauthorized');
        if (!messageData) throw new Error('메시지 데이터가 없습니다.');

        const { room, type, content, fileData } = messageData;
        if (!room) throw new Error('채팅방 정보가 없습니다.');

        const chatRoom = await redisDataLayer.getRoomById(room);
        if (!chatRoom || !chatRoom.participants.includes(socket.user.id)) {
          throw new Error('채팅방 접근 권한이 없습니다.');
        }

        const sessionValidation = await SessionService.validateSession(socket.user.id, socket.user.sessionId);
        if (!sessionValidation.isValid) {
          throw new Error('세션이 만료되었습니다. 다시 로그인해주세요.');
        }

        const aiMentions = extractAIMentions(content || '');
        let messageId;
        let finalContent = content?.trim();

        switch (type) {
          case 'file':
            if (!fileData || !fileData._id) {
              throw new Error('파일 데이터가 올바르지 않습니다.');
            }
            const file = await redisDataLayer.getFile(fileData._id);
            if (!file || file.user !== socket.user.id) {
              throw new Error('파일을 찾을 수 없거나 접근 권한이 없습니다.');
            }

            messageId = await redisDataLayer.createMessage(room, {
              type: 'file',
              sender: socket.user.id,
              fileId: file._id,
              content: finalContent || ''
            });
            break;
          case 'text':
            if (!finalContent || finalContent.length === 0) return;
            messageId = await redisDataLayer.createMessage(room, {
              type: 'text',
              sender: socket.user.id,
              content: finalContent
            });
            break;
          default:
            throw new Error('지원하지 않는 메시지 타입입니다.');
        }

        const msg = await redisDataLayer.getMessage(messageId);
        console.log('Message:', msg);
        if (!msg) throw new Error('메시지 생성 중 오류 발생');

        // sender 정보 로딩
        const senderUser = await redisDataLayer.getUserById(msg.sender);
        console.log('Sender User:', senderUser);
        msg.sender = senderUser ? {
          _id: senderUser.id,
          name: senderUser.name,
          email: senderUser.email,
          profileImage: senderUser.profileImage
        } : { _id: 'unknown', name: '알 수 없음', email: '', profileImage: '' };

        // file 정보 로딩 (file 메시지일 경우)
        if (msg.type === 'file' && msg.file) {
          const f = await redisDataLayer.getFile(msg.file);
          if (f) {
            msg.file = {
              _id: f._id,
              filename: f.filename,
              originalname: f.originalname,
              mimetype: f.mimetype,
              size: f.size
            };
          }
        }

        io.to(room).emit('message', msg);

        if (aiMentions.length > 0) {
          for (const aiName of aiMentions) {
            const query = finalContent.replace(new RegExp(`@${aiName}\\b`, 'g'), '').trim();
            await handleAIResponse(io, room, aiName, query);
          }
        }

        await SessionService.updateLastActivity(socket.user.id);

        logDebug('message processed', { messageId: msg._id, type: msg.type, room });

      } catch (error) {
        console.error('Message handling error:', error);
        socket.emit('error', {
          code: error.code || 'MESSAGE_ERROR',
          message: error.message || '메시지 전송 중 오류가 발생했습니다.'
        });
      }
    });

    socket.on('leaveRoom', async (roomId) => {
      try {
        if (!socket.user) throw new Error('Unauthorized');

        const currentRoom = userRooms.get(socket.user.id);
        if (!currentRoom || currentRoom !== roomId) {
          console.log(`User ${socket.user.id} is not in room ${roomId}`);
          return;
        }

        const room = await redisDataLayer.getRoomById(roomId);
        if (!room || !room.participants.includes(socket.user.id)) {
          console.log(`Room ${roomId} not found or user has no access`);
          return;
        }

        socket.leave(roomId);
        userRooms.delete(socket.user.id);

        const leaveMsgId = await redisDataLayer.createMessage(roomId, {
          type: 'system',
          content: `${socket.user.name}님이 퇴장하였습니다.`,
          sender: 'system'
        });
        const leaveMessage = await redisDataLayer.getMessage(leaveMsgId);

        await redisDataLayer.removeParticipant(roomId, socket.user.id);
        const updatedRoom = await redisDataLayer.getRoomById(roomId);

        // 스트리밍 세션 정리
        for (const [messageId, session] of streamingSessions.entries()) {
          if (session.room === roomId && session.userId === socket.user.id) {
            streamingSessions.delete(messageId);
          }
        }

        // 메시지 큐 정리
        const queueKey = `${roomId}:${socket.user.id}`;
        messageQueues.delete(queueKey);
        messageLoadRetries.delete(queueKey);

        const participantsData = [];
        if (updatedRoom) {
          for (const pid of updatedRoom.participants) {
            const pu = await redisDataLayer.getUserById(pid);
            if (pu) participantsData.push({ _id: pu.id, name: pu.name, email: pu.email, profileImage: pu.profileImage });
          }
        }

        io.to(roomId).emit('message', leaveMessage);
        io.to(roomId).emit('participantsUpdate', participantsData);

        console.log(`User ${socket.user.id} left room ${roomId} successfully`);
      } catch (error) {
        console.error('Leave room error:', error);
        socket.emit('error', {
          message: error.message || '채팅방 퇴장 중 오류가 발생했습니다.'
        });
      }
    });

    socket.on('disconnect', async (reason) => {
      if (!socket.user) return;

      try {
        if (connectedUsers.get(socket.user.id) === socket.id) {
          connectedUsers.delete(socket.user.id);
        }

        const roomId = userRooms.get(socket.user.id);
        userRooms.delete(socket.user.id);

        const userQueues = Array.from(messageQueues.keys()).filter(key => key.endsWith(`:${socket.user.id}`));
        userQueues.forEach(key => {
          messageQueues.delete(key);
          messageLoadRetries.delete(key);
        });

        for (const [messageId, session] of streamingSessions.entries()) {
          if (session.userId === socket.user.id) {
            streamingSessions.delete(messageId);
          }
        }

        if (roomId && reason !== 'client namespace disconnect' && reason !== 'duplicate_login') {
          const leaveMsgId = await redisDataLayer.createMessage(roomId, {
            type: 'system',
            content: `${socket.user.name}님이 연결이 끊어졌습니다.`,
            sender: 'system'
          });
          const leaveMessage = await redisDataLayer.getMessage(leaveMsgId);

          await redisDataLayer.removeParticipant(roomId, socket.user.id);
          const updatedRoom = await redisDataLayer.getRoomById(roomId);

          if (updatedRoom) {
            const participantsData = [];
            for (const pid of updatedRoom.participants) {
              const pu = await redisDataLayer.getUserById(pid);
              if (pu) participantsData.push({ _id: pu.id, name: pu.name, email: pu.email, profileImage: pu.profileImage });
            }

            io.to(roomId).emit('message', leaveMessage);
            io.to(roomId).emit('participantsUpdate', participantsData);
          }
        }

        logDebug('user disconnected', {
          reason,
          userId: socket.user.id,
          socketId: socket.id,
          lastRoom: roomId
        });

      } catch (error) {
        console.error('Disconnect handling error:', error);
      }
    });

    socket.on('force_login', async ({ token }) => {
      try {
        if (!socket.user) return;

        const decoded = jwt.verify(token, jwtSecret);
        if (!decoded?.user?.id || decoded.user.id !== socket.user.id) {
          throw new Error('Invalid token');
        }

        socket.emit('session_ended', {
          reason: 'force_logout',
          message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
        });

        socket.disconnect(true);

      } catch (error) {
        console.error('Force login error:', error);
        socket.emit('error', {
          message: '세션 종료 중 오류가 발생했습니다.'
        });
      }
    });

    socket.on('markMessagesAsRead', async ({ roomId, messageIds }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        if (!Array.isArray(messageIds) || messageIds.length === 0) {
          return;
        }

        await redisDataLayer.markMessagesAsRead(socket.user.id, roomId, messageIds);

        socket.to(roomId).emit('messagesRead', {
          userId: socket.user.id,
          messageIds
        });

      } catch (error) {
        console.error('Mark messages as read error:', error);
        socket.emit('error', {
          message: '읽음 상태 업데이트 중 오류가 발생했습니다.'
        });
      }
    });

    socket.on('messageReaction', async ({ messageId, reaction, type }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        const msg = await redisDataLayer.getMessage(messageId);
        if (!msg) {
          throw new Error('메시지를 찾을 수 없습니다.');
        }

        if (type === 'add') {
          await redisDataLayer.addReaction(messageId, reaction, socket.user.id);
        } else if (type === 'remove') {
          await redisDataLayer.removeReaction(messageId, reaction, socket.user.id);
        }

        const reactions = await redisDataLayer.getReactions(messageId);
        io.to(msg.room).emit('messageReactionUpdate', {
          messageId,
          reactions
        });

      } catch (error) {
        console.error('Message reaction error:', error);
        socket.emit('error', {
          message: error.message || '리액션 처리 중 오류가 발생했습니다.'
        });
      }
    });
  });

  function extractAIMentions(content) {
    if (!content) return [];
    const aiTypes = ['wayneAI', 'consultingAI'];
    const mentions = new Set();
    const mentionRegex = /@(wayneAI|consultingAI)\b/g;
    let match;
    while ((match = mentionRegex.exec(content)) !== null) {
      if (aiTypes.includes(match[1])) {
        mentions.add(match[1]);
      }
    }
    return Array.from(mentions);
  }

  async function handleAIResponse(io, room, aiName, query) {
    const messageId = `${aiName}-${Date.now()}`;
    let accumulatedContent = '';
    const timestamp = new Date();

    streamingSessions.set(messageId, {
      room,
      aiType: aiName,
      content: '',
      messageId,
      timestamp,
      lastUpdate: Date.now(),
      reactions: {}
    });

    logDebug('AI response started', { messageId, aiType: aiName, room, query });
    io.to(room).emit('aiMessageStart', { messageId, aiType: aiName, timestamp });

    try {
      await aiService.generateResponse(query, aiName, {
        onStart: () => {
          logDebug('AI generation started', { messageId, aiType: aiName });
        },
        onChunk: async (chunk) => {
          accumulatedContent += chunk.currentChunk || '';
          const session = streamingSessions.get(messageId);
          if (session) {
            session.content = accumulatedContent;
            session.lastUpdate = Date.now();
          }

          io.to(room).emit('aiMessageChunk', {
            messageId,
            currentChunk: chunk.currentChunk,
            fullContent: accumulatedContent,
            isCodeBlock: chunk.isCodeBlock,
            timestamp: new Date(),
            aiType: aiName,
            isComplete: false
          });
        },
        onComplete: async (finalContent) => {
          streamingSessions.delete(messageId);

          const aiMsgId = await redisDataLayer.createMessage(room, {
            type: 'ai',
            aiType: aiName,
            content: finalContent.content,
            metadata: {
              query,
              generationTime: Date.now() - timestamp,
              completionTokens: finalContent.completionTokens,
              totalTokens: finalContent.totalTokens
            }
          });

          const aiMessage = await redisDataLayer.getMessage(aiMsgId);

          io.to(room).emit('aiMessageComplete', {
            messageId,
            _id: aiMessage._id,
            content: finalContent.content,
            aiType: aiName,
            timestamp: new Date(),
            isComplete: true,
            query,
            reactions: {}
          });

          logDebug('AI response completed', {
            messageId,
            aiType: aiName,
            contentLength: finalContent.content.length,
            generationTime: Date.now() - timestamp
          });
        },
        onError: (error) => {
          streamingSessions.delete(messageId);
          console.error('AI response error:', error);
          io.to(room).emit('aiMessageError', {
            messageId,
            error: error.message || 'AI 응답 생성 중 오류가 발생했습니다.',
            aiType: aiName
          });
          logDebug('AI response error', {
            messageId,
            aiType: aiName,
            error: error.message
          });
        }
      });
    } catch (error) {
      streamingSessions.delete(messageId);
      console.error('AI service error:', error);
      io.to(room).emit('aiMessageError', {
        messageId,
        error: error.message || 'AI 서비스 오류가 발생했습니다.',
        aiType: aiName
      });
      logDebug('AI service error', {
        messageId,
        aiType: aiName,
        error: error.message
      });
    }
  }

  return io;
};