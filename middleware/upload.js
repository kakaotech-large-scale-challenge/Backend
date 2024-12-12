const multer = require('multer');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const multerS3 = require('multer-s3');
const crypto = require('crypto');

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// S3 버킷 이름
const BUCKET_NAME = process.env.S3_BUCKET_NAME;

// 허용된 파일 형식과 확장자 매핑 정의
const ALLOWED_TYPES = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
  'video/mp4': ['.mp4'],
  'video/webm': ['.webm'],
  'video/quicktime': ['.mov'],
  'audio/mpeg': ['.mp3'],
  'audio/wav': ['.wav'],
  'audio/ogg': ['.ogg'],
  'application/pdf': ['.pdf'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx']
};

// 파일 유형별 최대 크기 제한 설정
const FILE_SIZE_LIMITS = {
  image: 10 * 1024 * 1024,  // 이미지: 10MB
  video: 50 * 1024 * 1024,  // 동영상: 50MB
  audio: 20 * 1024 * 1024,  // 오디오: 20MB
  document: 20 * 1024 * 1024 // 문서: 20MB
};

// multer 스토리지 설정
const storage = multerS3({
  s3: s3,
  bucket: BUCKET_NAME,
  contentType: multerS3.AUTO_CONTENT_TYPE,
  key: (req, file, cb) => {
    try {
      // 원본 파일명을 UTF-8로 디코딩
      const originalname = Buffer.from(file.originalname, 'binary').toString('utf8');

      // 원본 파일명을 요청 객체에 저장
      req.originalFileName = originalname;
      // 파일 확장자 추출
      const ext = path.extname(file.originalname).toLowerCase();
      
      // 허용된 확장자인지 검증
      const allowedExtensions = Object.values(ALLOWED_TYPES).flat();
      if (!allowedExtensions.includes(ext)) {
        return cb(new Error('지원하지 않는 파일 확장자입니다.'));
      }

      // 고유 파일명 생성 (타임스탬프 + 랜덤 문자열 + 확장자)
      const timestamp = Date.now();
      const randomString = Math.random().toString(36).substring(2, 15);
      const safeFilename = `${timestamp}_${randomString}${ext}`;

      // S3에 저장될 키 설정
      cb(null, safeFilename);
    } catch (error) {
      console.error('Filename processing error:', error);
      cb(new Error('파일명 처리 중 오류가 발생했습니다.'));
    }
  },
});

// 파일 유형에 따른 한글 표시명 반환
const getFileType = (mimetype) => {
  const typeMap = {
    'image': '이미지',
    'video': '동영상',
    'audio': '오디오',
    'application': '문서'
  };
  const type = mimetype.split('/')[0];
  return typeMap[type] || '파일';
};

// 파일 크기 검증 함수
const validateFileSize = (file) => {
  const type = file.mimetype.split('/')[0];
  const limit = FILE_SIZE_LIMITS[type] || FILE_SIZE_LIMITS.document;
  
  if (file.size > limit) {
    const limitInMB = Math.floor(limit / 1024 / 1024);
    throw new Error(`${getFileType(file.mimetype)} 파일은 ${limitInMB}MB를 초과할 수 없습니다.`);
  }
  return true;
};

// 파일 필터링 함수 (업로드 전 파일 검증)
const fileFilter = (req, file, cb) => {
  try {
    // 파일명 UTF-8 디코딩
    const originalname = Buffer.from(file.originalname, 'binary').toString('utf8');
    
    // MIME 타입 검증
    if (!ALLOWED_TYPES[file.mimetype]) {
      const fileType = getFileType(file.mimetype);
      return cb(new Error(`지원하지 않는 ${fileType} 형식입니다.`), false);
    }

    // Content-Length 헤더로 파일 크기 검증
    const declaredSize = parseInt(req.headers['content-length']);
    if (declaredSize > 50 * 1024 * 1024) {
      return cb(new Error('파일 크기는 50MB를 초과할 수 없습니다.'), false);
    }

    // 파일명 길이 검증 (UTF-8 바이트 기준)
    const filenameBytes = Buffer.from(originalname, 'utf8').length;
    if (filenameBytes > 255) {
      return cb(new Error('파일명이 너무 깁니다.'), false);
    }

    // 파일 확장자와 MIME 타입 일치 여부 확인
    const ext = path.extname(originalname).toLowerCase();
    if (!ALLOWED_TYPES[file.mimetype].includes(ext)) {
      const fileType = getFileType(file.mimetype);
      return cb(new Error(`${fileType} 확장자가 올바르지 않습니다.`), false);
    }

    file.originalname = originalname;
    cb(null, true);
  } catch (error) {
    console.error('File filter error:', error);
    cb(error);
  }
};

// multer 미들웨어 설정
const uploadMiddleware = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 전체 파일 크기 제한: 50MB
    files: 1 // 동시 업로드 파일 수 제한: 1개
  },
  fileFilter: fileFilter
});

// 파일 업로드 에러 처리 미들웨어
const errorHandler = (error, req, res, next) => {
  console.error('File upload error:', {
    error: error.message,
    stack: error.stack,
    file: req.file
  });

  // multer 에러 유형별 처리
  if (error instanceof multer.MulterError) {
    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        return res.status(413).json({
          success: false,
          message: '파일 크기는 50MB를 초과할 수 없습니다.'
        });
      case 'LIMIT_FILE_COUNT':
        return res.status(400).json({
          success: false,
          message: '한 번에 하나의 파일만 업로드할 수 있습니다.'
        });
      case 'LIMIT_UNEXPECTED_FILE':
        return res.status(400).json({
          success: false,
          message: '잘못된 형식의 파일입니다.'
        });
      default:
        return res.status(400).json({
          success: false,
          message: `파일 업로드 오류: ${error.message}`
        });
    }
  }
  
  // 기타 에러 처리
  if (error) {
    return res.status(400).json({
      success: false,
      message: error.message || '파일 업로드 중 오류가 발생했습니다.'
    });
  }
  
  next();
};


// 모듈 내보내기
module.exports = {
  upload: uploadMiddleware,
  errorHandler,
  uploadDir,
  validateFileSize,
  ALLOWED_TYPES,
  getFileType
};