require('dotenv').config();
console.log('환경변수 확인:', {
  NODE_ENV: process.env.NODE_ENV
});
const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const { router: roomsRouter, initializeSocket } = require('./routes/api/rooms');
const routes = require('./routes');
// Redis
const healthRouter = require('./controllers/health');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;

// trust proxy 설정 추가
app.set('trust proxy', 1);

// CORS 설정
const corsOptions = {
  origin: function(origin, callback) {
    const allowedOrigins = [
      'https://bootcampchat-fe.run.goorm.site',
      'http://localhost:3000',
      'https://localhost:3000',
      'http://0.0.0.0:3000',
      'https://0.0.0.0:3000',
      'http://chat.goorm-ktb-001.goorm.team',
      'https://chat.goorm-ktb-001.goorm.team',
      'http://api.chat.goorm-ktb-001.goorm.team',
      'https://api.chat.goorm-ktb-001.goorm.team'
    ];

    // origin이 없는 경우(서버 간 요청) 허용
    if (!origin) {
      return callback(null, true);
    }

    // allowedOrigins에 포함되어 있거나 development 환경이면 허용
    if (allowedOrigins.includes(origin) || process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'x-auth-token', 
    'x-session-id',
    'Cache-Control',
    'Pragma'
  ],
  exposedHeaders: ['x-auth-token', 'x-session-id']
};

// 기본 미들웨어
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// OPTIONS 요청에 대한 처리
app.options('*', cors(corsOptions));

// 정적 파일 제공
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 요청 로깅
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    next();
  });
}

// 기본 상태 체크
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV
  });
});

// API 라우트 마운트
app.use('/api', routes);

// Redis
app.use('/api/v1/health', healthRouter);

// Socket.IO 설정
// const io = socketIO(server, { cors: corsOptions });
const io = socketIO(server, {
  cors: corsOptions,
  pingTimeout: 120000,     // 60초
  pingInterval: 60000,    // 25초
  connectTimeout: 60000,  // 30초
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 2000,
  reconnectionDelayMax: 10000,
  maxHttpBufferSize: 1e8 
});
require('./sockets/chat')(io);

// Socket.IO 객체 전달
initializeSocket(io);

// 404 에러 핸들러
app.use((req, res) => {
  console.log('404 Error:', req.originalUrl);
  res.status(404).json({
    success: false,
    message: '요청하신 리소스를 찾을 수 없습니다.',
    path: req.originalUrl
  });
});

// 글로벌 에러 핸들러
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || '서버 에러가 발생했습니다.',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// 서버 시작
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Environment:', process.env.NODE_ENV);
  console.log('API Base URL:', `http://0.0.0.0:${PORT}/api`);
});

module.exports = { app, server };