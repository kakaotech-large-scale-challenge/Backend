// services/sessionService.js
const redisClient = require('../utils/redisClient');
const crypto = require('crypto');

class SessionService {
  static SESSION_TTL = 24 * 60 * 60; // 24 hours
  static SESSION_PREFIX = 'session:';
  static SESSION_ID_PREFIX = 'sessionId:';
  static USER_SESSIONS_PREFIX = 'user_sessions:';
  static ACTIVE_SESSION_PREFIX = 'active_session:';

  static async createSession(userId, metadata = {}) {
    try {
      // 기존 세션들 모두 제거
      await this.removeAllUserSessions(userId);

      const sessionId = this.generateSessionId();
      const sessionData = {
        userId,
        sessionId,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        metadata: {
          userAgent: metadata.userAgent || '',
          ipAddress: metadata.ipAddress || '',
          deviceInfo: metadata.deviceInfo || '',
          ...metadata
        }
      };

      await Promise.all([
        redisClient.set(this.getSessionKey(userId), sessionData, { ttl: this.SESSION_TTL }),
        redisClient.set(this.getSessionIdKey(sessionId), userId.toString(), { ttl: this.SESSION_TTL }),
        redisClient.set(this.getActiveSessionKey(userId), sessionId, { ttl: this.SESSION_TTL }),
        redisClient.set(this.getUserSessionsKey(userId), sessionId, { ttl: this.SESSION_TTL })
      ]);

      return {
        sessionId,
        expiresIn: this.SESSION_TTL,
        sessionData
      };

    } catch (error) {
      console.error('Session creation error:', error);
      throw new Error('세션 생성 중 오류가 발생했습니다.');
    }
  }

  static async getActiveSession(userId) {
    try {
      if (!userId) {
        console.error('getActiveSession: userId is required');
        return null;
      }

      const activeSessionKey = this.getActiveSessionKey(userId);
      const sessionId = await redisClient.get(activeSessionKey);

      if (!sessionId) {
        return null;
      }

      const sessionKey = this.getSessionKey(userId);
      const sessionData = await redisClient.get(sessionKey);

      if (!sessionData) {
        await redisClient.del(activeSessionKey);
        return null;
      }

      return {
        ...sessionData,
        userId,
        sessionId
      };
    } catch (error) {
      console.error('Get active session error:', error);
      return null;
    }
  }

  static async validateSession(userId, sessionId) {
    try {
      if (!userId || !sessionId) {
        return {
          isValid: false,
          error: 'INVALID_PARAMETERS',
          message: '유효하지 않은 세션 파라미터'
        };
      }

      const activeSessionKey = this.getActiveSessionKey(userId);
      const activeSessionId = await redisClient.get(activeSessionKey);

      if (!activeSessionId || activeSessionId !== sessionId) {
        console.log('Session validation failed:', {
          userId,
          sessionId,
          activeSessionId
        });

        await this.removeAllUserSessions(userId);

        return {
          isValid: false,
          error: 'INVALID_SESSION',
          message: '다른 기기에서 로그인되어 현재 세션이 만료되었습니다.'
        };
      }

      const sessionData = await redisClient.get(this.getSessionKey(userId));
      if (!sessionData) {
        return {
          isValid: false,
          error: 'SESSION_NOT_FOUND',
          message: '세션을 찾을 수 없습니다.'
        };
      }

      if (Date.now() - sessionData.lastActivity > this.SESSION_TTL * 1000) {
        await this.removeAllUserSessions(userId);
        return {
          isValid: false,
          error: 'SESSION_EXPIRED',
          message: '세션이 만료되었습니다.'
        };
      }

      sessionData.lastActivity = Date.now();
      await Promise.all([
        redisClient.set(this.getSessionKey(userId), sessionData, { ttl: this.SESSION_TTL }),
        redisClient.set(activeSessionKey, sessionId, { ttl: this.SESSION_TTL }),
        redisClient.set(this.getUserSessionsKey(userId), sessionId, { ttl: this.SESSION_TTL }),
        redisClient.set(this.getSessionIdKey(sessionId), userId.toString(), { ttl: this.SESSION_TTL })
      ]);

      return {
        isValid: true,
        session: sessionData
      };

    } catch (error) {
      console.error('Session validation error:', error);
      return {
        isValid: false,
        error: 'VALIDATION_ERROR',
        message: '세션 검증 중 오류가 발생했습니다.'
      };
    }
  }

  static async removeAllUserSessions(userId) {
    try {
      const userSessionsKey = this.getUserSessionsKey(userId);
      const activeSessionKey = this.getActiveSessionKey(userId);
      const sessionKey = this.getSessionKey(userId);
      const oldSessionId = await redisClient.get(userSessionsKey);

      const deletePromises = [
        redisClient.del(sessionKey),
        redisClient.del(userSessionsKey),
        redisClient.del(activeSessionKey)
      ];

      if (oldSessionId) {
        deletePromises.push(redisClient.del(this.getSessionIdKey(oldSessionId)));
      }

      await Promise.all(deletePromises);
      return true;
    } catch (error) {
      console.error('Remove all user sessions error:', error);
      return false;
    }
  }

  static async updateLastActivity(userId) {
    try {
      if (!userId) {
        console.error('updateLastActivity: userId is required');
        return false;
      }

      const sessionKey = this.getSessionKey(userId);
      const sessionData = await redisClient.get(sessionKey);

      if (!sessionData) {
        console.error('updateLastActivity: No session found for user', userId);
        return false;
      }

      // 세션 데이터 갱신
      sessionData.lastActivity = Date.now();

      // Promise.all을 사용하여 모든 관련 키의 TTL 갱신
      const activeSessionKey = this.getActiveSessionKey(userId);
      const userSessionsKey = this.getUserSessionsKey(userId);

      await Promise.all([
        redisClient.set(sessionKey, sessionData, { ttl: this.SESSION_TTL }),
        redisClient.set(activeSessionKey, sessionData.sessionId, { ttl: this.SESSION_TTL }),
        redisClient.set(userSessionsKey, sessionData.sessionId, { ttl: this.SESSION_TTL }),
        redisClient.set(this.getSessionIdKey(sessionData.sessionId), userId.toString(), { ttl: this.SESSION_TTL })
      ]);

      return true;

    } catch (error) {
      console.error('Update last activity error:', error);
      return false;
    }
  }

  static generateSessionId() {
    return crypto.randomBytes(32).toString('hex');
  }

  static getSessionKey(userId) {
    return `${this.SESSION_PREFIX}${userId}`;
  }

  static getSessionIdKey(sessionId) {
    return `${this.SESSION_ID_PREFIX}${sessionId}`;
  }

  static getUserSessionsKey(userId) {
    return `${this.USER_SESSIONS_PREFIX}${userId}`;
  }

  static getActiveSessionKey(userId) {
    return `${this.ACTIVE_SESSION_PREFIX}${userId}`;
  }
  static async removeSession(userId, sessionId = null) {
    try {
      const userSessionsKey = this.getUserSessionsKey(userId);
      const activeSessionKey = this.getActiveSessionKey(userId);

      if (sessionId) {
        const currentSessionId = await redisClient.get(userSessionsKey);
        if (currentSessionId === sessionId) {
          await Promise.all([
            redisClient.del(this.getSessionKey(userId)),
            redisClient.del(this.getSessionIdKey(sessionId)),
            redisClient.del(userSessionsKey),
            redisClient.del(activeSessionKey)
          ]);
        }
      } else {
        const storedSessionId = await redisClient.get(userSessionsKey);
        if (storedSessionId) {
          await Promise.all([
            redisClient.del(this.getSessionKey(userId)),
            redisClient.del(this.getSessionIdKey(storedSessionId)),
            redisClient.del(userSessionsKey),
            redisClient.del(activeSessionKey)
          ]);
        }
      }
      return true;
    } catch (error) {
      console.error('Session removal error:', error);
      return false;
    }
  }
}


module.exports = SessionService;