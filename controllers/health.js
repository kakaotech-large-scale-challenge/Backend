// controllers/health.js

const express = require('express');
const router = express.Router();
const Redis = require('ioredis'); // 데이터베이스 연결을 위한 모듈

// Redis 클라이언트 설정
const redis = new Redis({
    host: process.env.REDIS_MASTER1 || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    // 필요한 경우 추가 옵션 설정
    // password: process.env.REDIS_PASSWORD,
    // db: 0
});

router.get('/', async (req, res) => {
    try {
      // Redis PING 명령어로 연결 상태 확인
      const result = await redis.ping();
      
      if (result === 'PONG') {
        // Redis가 정상적으로 응답하면 OK 반환
        res.status(200).send('OK');
      } else {
        throw new Error('Redis not responding properly');
      }
    } catch (err) {
      console.error('Redis health check failed:', err);
      // 문제가 있으면 500 반환
      res.status(500).send('Unhealthy');
    }
  });

// router.get('/', async (req, res) => {
//     try {
//         const dbState = mongoose.connection.readyState;
//         console.log('Current MongoDB connection state:', dbState);
        
//         // MongoDB connection states
//         const states = {
//             0: 'disconnected',
//             1: 'connected',
//             2: 'connecting',
//             3: 'disconnecting'
//         };
//         console.log('Connection status:', states[dbState]);

//         if (dbState === 1) {
//             res.status(200).send('OK');
//         } else {
//             console.log('Database not fully connected. Current state:', states[dbState]);
//             throw new Error('Database not connected');
//         }
//     } catch (err) {
//         // 문제가 있으면 500 반환
//         res.status(500).send('Unhealthy');
//     }
// });

module.exports = router;