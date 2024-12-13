const AWS = require('aws-sdk'); // AWS SDK 추가
require('dotenv').config();
const File = require('../models/File');
const Message = require('../models/Message');
const Room = require('../models/Room');
const { processFileForRAG } = require('../services/fileService');
const {S3Client,GetObjectCommand,DeleteObjectCommand} = require('@aws-sdk/client-s3')
const {getSignedUrl} = require('@aws-sdk/s3-request-presigner');
const { promisify } = require('util');
const crypto = require('crypto');
const { uploadDir } = require('../middleware/upload');
const multerS3 = require('multer-s3');
const path = require('path');
const redisDataLayer = require('../data/redisDataLayer');

const s3AWS = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID, // AWS Access Key ID
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, // AWS Secret Access Key
  region: process.env.AWS_REGION, // AWS Region
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME;

// AWS S3 설정
// const s3 = new S3Client({
const s3 = new AWS.S3({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});



// // 안전한 파일명 생성 함수 (타임스탬프와 랜덤값 조합)
// const generateSafeFilename = (originalFilename) => {
//   const ext = path.extname(originalFilename || '').toLowerCase();
//   const timestamp = Date.now();
//   const randomBytes = crypto.randomBytes(8).toString('hex');
//   return `${timestamp}_${randomBytes}${ext}`;
// };

// const storage = multerS3({
//   s3: s3, // 새로운 S3Client 인스턴스 사용
//   bucket: BUCKET_NAME,
//   contentType: multerS3.AUTO_CONTENT_TYPE,
//   key: (req, file, cb) => {
//     const safeFilename = generateSafeFilename(file.originalname);
//     req.originalFileName = file.originalname;
//     cb(null, safeFilename);
//   },
// });

// // 요청에서 파일 정보를 조회하고 권한을 검증하는 함수
// const getFileFromRequest = async (req) => {
//   try {
//     const fileID = req.params.filename;
//     const token = req.headers['x-auth-token'] || req.query.token;
//     const sessionId = req.headers['x-session-id'] || req.query.sessionId;
    
//     // 기본 유효성 검사
//     if (!fileId) {
//       throw new Error('Invalid filename');
//     }

//     if (!token || !sessionId) {
//       throw new Error('Authentication required');
//     }
//     // DB에서 파일 정보 조회
//     const file = await File.findOne({ filename: filename });
//     if (!file) {
//       throw new Error('File not found in database');
//     }

//     // 파일과 연관된 메시지 조회
//     const message = await Message.findOne({ file: file._id });
//     if (!message) {
//       throw new Error('File message not found');
//     }

//     // 사용자의 채팅방 접근 권한 확인
//     const room = await Room.findOne({
//       _id: message.room,
//       participants: req.user.id
//     });

//     if (!room) {
//       throw new Error('Unauthorized access');
//     }

//     return { file };
//   } catch (error) {
//     console.error('getFileFromRequest error:', {
//       filename: req.params.filename,
//       error: error.message
//     });
//     throw error;
//   }
// };

// // 파일 업로드 처리 함수
// exports.uploadFile = async (req, res) => {
//   try {
//     // 파일 존재 여부 확인
//     if (!req.file) {
//       return res.status(400).json({
//         success: false,
//         message: '파일이 선택되지 않았습니다.'
//       });
//     }

//     // DB에 파일 정보 저장
//     const file = new File({
//       filename: req.file.key, // S3 객체 키
//       originalname: req.originalFileName,
//       mimetype: req.file.mimetype,
//       size: req.file.size,
//       user: req.user.id,
//       path: req.file.location, // S3 URL
//     });

//     await file.save();

//     // 성공 응답
//     res.status(200).json({
//       success: true,
//       message: '파일 업로드 성공',
//       file: {
//         _id: file._id,
//         filename: file.filename,
//         originalname: file.originalname,
//         mimetype: file.mimetype,
//         size: file.size,
//         uploadDate: file.uploadDate,
//         url: file.path, // S3 URL
//       },
//     });

//   } catch (error) {
//     console.error('File upload error:', error);
//     res.status(500).json({
//       success: false,
//       message: '파일 업로드 중 오류가 발생했습니다.',
//       error: error.message,
//     });
//   }
// };

// // 파일 다운로드 처리 함수
// exports.downloadFile = async (req, res) => {
//   try {
//     // 파일 정보 조회 및 권한 검증
//     const { file} = await getFileFromRequest(req);
//     // S3 객체 스트리밍
//     const params = {
//       Bucket: BUCKET_NAME,
//       Key: file.filename, // S3 객체 키
//     };
//     const contentDisposition = file.getContentDisposition('attachment');
//     const command = new GetObjectCommand(params);
//     const objectStream = await s3.send(command);
//     // 응답 헤더 설정
//     res.set({
//       'Content-Type': file.mimetype,
//       'Content-Length': file.size,
//       'Content-Disposition': contentDisposition,
//       'Cache-Control': 'private, no-cache, no-store, must-revalidate',
//       'Pragma': 'no-cache',
//       'Expires': '0'
//     });

//     objectStream.Body.pipe(res);

//   } catch (error) {
//     handleFileError(error, res);
//   }
// };

// // 파일 미리보기 처리 함수
// exports.viewFile = async (req, res) => {
//   try {
//     // 파일 정보 조회 및 권한 검증
//     const { file} = await getFileFromRequest(req);

//     // 미리보기 가능 여부 확인
//     if (!file.isPreviewable()) {
//       return res.status(415).json({
//         success: false,
//         message: '미리보기를 지원하지 않는 파일 형식입니다.'
//       });
//     }

//     // S3 객체 가져오기
//     const params = {
//       Bucket: BUCKET_NAME,
//       Key: file.filename,
//     };
//     const command = new GetObjectCommand(params);
//     const { Body, ContentType } = await s3.send(command);

//     // 응답 헤더 설정 (캐시 활성화)
//     res.set({
//       'Content-Type': ContentType || file.mimetype,
//       'Content-Disposition': file.getContentDisposition('inline'),
//       'Cache-Control': 'public, max-age=31536000, immutable',
//     });

//     // S3 객체 스트림을 클라이언트로 전달
//     Body.pipe(res);

//   } catch (error) {
//     console.error('View file error:', error);
//     res.status(500).json({
//       success: false,
//       message: '파일 미리보기 중 오류가 발생했습니다.',
//     });
//   }
// };

// // 파일 관련 에러 처리 함수
// const handleFileError = (error, res) => {
//   console.error('File operation error:', {
//     message: error.message,
//     stack: error.stack
//   });

//   if (error.name === 'NoSuchKey') {
//     return res.status(404).json({
//       success: false,
//       message: '파일이 S3에서 존재하지 않습니다.',
//     });
//   }
//   // 에러 유형별 응답 매핑
//   const errorResponses = {
//     'Invalid filename': { status: 400, message: '잘못된 파일명입니다.' },
//     'Authentication required': { status: 401, message: '인증이 필요합니다.' },
//     'Invalid file path': { status: 400, message: '잘못된 파일 경로입니다.' },
//     'File not found in database': { status: 404, message: '파일을 찾을 수 없습니다.' },
//     'File message not found': { status: 404, message: '파일 메시지를 찾을 수 없습니다.' },
//     'Unauthorized access': { status: 403, message: '파일에 접근할 권한이 없습니다.' },
//     'ENOENT': { status: 404, message: '파일을 찾을 수 없습니다.' }
//   };

//   const errorResponse = errorResponses[error.message] || {
//     status: 500,
//     message: '파일 처리 중 오류가 발생했습니다.'
//   };

//   res.status(errorResponse.status).json({
//     success: false,
//     message: errorResponse.message
//   });
// };

// // 파일 삭제 처리 함수
// exports.deleteFile = async (req, res) => {
//   try {
//     // 파일 정보 조회
//     const file = await File.findById(req.params.id);
    
//     if (!file) {
//       return res.status(404).json({
//         success: false,
//         message: '파일을 찾을 수 없습니다.'
//       });
//     }

//     // 파일 소유자 확인
//     if (file.user.toString() !== req.user.id) {
//       return res.status(403).json({
//         success: false,
//         message: '파일을 삭제할 권한이 없습니다.'
//       });
//     }
//     // S3 객체 삭제
//     const deleteParams = {
//       Bucket: BUCKET_NAME,
//       Key: file.filename,
//     };

//     await s3.send(new DeleteObjectCommand(deleteParams));

//     // DB에서 파일 정보 삭제
//     await file.deleteOne();

//     res.json({
//       success: true,
//       message: '파일이 삭제되었습니다.'
//     });
//   } catch (error) {
//     console.error('File deletion error:', error);
//     res.status(500).json({
//       success: false,
//       message: '파일 삭제 중 오류가 발생했습니다.',
//       error: error.message
//     });
//   }
// };

const generateSafeFilename = (originalFilename) => {

  const sanitizedName = originalFilename
  .replace(/[^\w\s.-]/g, '')  // 특수문자 제거
  .replace(/\s+/g, '-')       // 공백을 하이픈으로 변환
  .toLowerCase();
  
  const ext = path.extname(originalFilename || '').toLowerCase();
  const timestamp = Date.now();
  const randomBytes = crypto.randomBytes(8).toString('hex');
  return `${timestamp}_${randomBytes}${ext}`;
};

const storage = multerS3({
  s3: s3,
  bucket: BUCKET_NAME,
  contentType: multerS3.AUTO_CONTENT_TYPE,
  key: (req, file, cb) => {
    req.originalFileName = Buffer.from(file.originalname, 'binary').toString('utf8');
    const safeFilename = generateSafeFilename(file.originalname);
    // req.originalFileName = file.originalname;
    cb(null, safeFilename);
  },
});

// Redis를 사용하는 파일 정보 조회 함수
const getFileFromRequest = async (req) => {
  try {
    const fileId = req.params.filename; // 파일 ID로 변경
    const token = req.headers['x-auth-token'] || req.query.token;
    const sessionId = req.headers['x-session-id'] || req.query.sessionId;
    console.log('File ID:', fileId); // 파일 ID가 잘 전달되는지 확인

    if (!fileId) {
      throw new Error('Invalid filename');
    }

    if (!token || !sessionId) {
      throw new Error('Authentication required');
    }

    // S3에서 파일 URL을 생성하는 부분
    const s3Params = {
      Bucket: BUCKET_NAME, // S3 버킷 이름
      Key: fileId, // 파일 ID를 Key로 사용 (파일 이름)
    };

    const url = s3.getSignedUrl('getObject', s3Params); // S3 URL 생성 (임시 URL)
    
    if (!url) {
      throw new Error('File not found in S3');
    }

    // return { url }; // S3 URL을 반환
    return { file: { filename: fileId, mimetype: 'image/png', originalname: fileId } };
  } catch (error) {
    console.error('getFileFromRequest error:', {
      fileId: req.params.filename,
      error: error.message,
    });
    throw error;
  }
  // try {
  //   const fileId = req.params.fileId; // 파일 ID로 변경
  //   const token = req.headers['x-auth-token'] || req.query.token;
  //   const sessionId = req.headers['x-session-id'] || req.query.sessionId;
  //   console.log(req.params.fileId);
  //   if (!fileId) {
  //     throw new Error('Invalid filename');
  //   }

  //   if (!token || !sessionId) {
  //     throw new Error('Authentication required');
  //   }

  //   const file = await redisDataLayer.getFile(fileId);
  //   if (!file) {
  //     throw new Error('File not found in database');
  //   }

  //   return { file };
  // } catch (error) {
  //   console.error('getFileFromRequest error:', {
  //     fileId: req.params.fileId,
  //     error: error.message
  //   });
  //   throw error;
  // }
};

// 파일 업로드 처리 함수
exports.uploadFile = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: '파일이 선택되지 않았습니다.'
      });
    }

    console.log('S3 Upload URL:', req.file.location);

    const fileId = await redisDataLayer.createFile({
      filename: req.file.key,
      originalname: Buffer.from(req.originalFileName, 'binary').toString('utf8'),
      mimetype: req.file.mimetype,
      size: req.file.size,
      userId: req.user.id,
      path: req.file.location
    });

    const fileDoc = await redisDataLayer.getFile(fileId);

    res.status(200).json({
      success: true,
      message: '파일 업로드 성공',
      file: {
        _id: fileDoc._id,
        filename: fileDoc.filename,
        originalname: fileDoc.originalname,
        mimetype: fileDoc.mimetype,
        size: fileDoc.size,
        uploadDate: fileDoc.uploadDate,
        url: fileDoc.path
      }
    });

  } catch (error) {
    console.error('File upload error:', error);
    res.status(500).json({
      success: false,
      message: '파일 업로드 중 오류가 발생했습니다.',
      error: error.message
    });
  }
};

// 파일 다운로드 처리 함수
exports.downloadFile = async (req, res) => {
  try {
    const { file } = await getFileFromRequest(req);
    const params = {
      Bucket: BUCKET_NAME,
      Key: file.filename,
    };
    
    // const command = new GetObjectCommand(params);
    // const objectStream = await s3.send(command);

    // res.set({
    //   'Content-Type': file.mimetype,
    //   'Content-Length': file.size,
    //   'Content-Disposition': `attachment; filename="${encodeURIComponent(file.originalname)}"`,
    //   'Cache-Control': 'private, no-cache, no-store, must-revalidate',
    //   'Pragma': 'no-cache',
    //   'Expires': '0'
    // });

    // objectStream.Body.pipe(res);

    s3AWS.getObject(params).createReadStream()
      .on('error', (error) => {
        console.error('S3 download error:', error);
        res.status(500).json({
          success: false,
          message: '파일 다운로드 중 오류가 발생했습니다.',
          error: error.message
        });
      })
      .pipe(res.set({
        'Content-Type': file.mimetype,
        'Content-Length': file.size,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(file.originalname)}"`,
        'Cache-Control': 'private, no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      }));


  } catch (error) {
    console.error('File download error:', error);
    res.status(500).json({
      success: false,
      message: '파일 다운로드 중 오류가 발생했습니다.',
      error: error.message
    });
  }
};

// 파일 미리보기 처리 함수
exports.viewFile = async (req, res) => {
  try {
    const { file } = await getFileFromRequest(req);

    const params = {
      Bucket: BUCKET_NAME,
      Key: file.filename,
    };
    
    // const command = new GetObjectCommand(params);
    // const { Body, ContentType } = await s3.send(command);
    const data = await s3AWS.getObject(params).promise();

    const contentType = file.mimetype || 'image/png';

    res.set({
      'Content-Type': file.mimetype,
      'Content-Disposition': `inline; filename="${encodeURIComponent(file.originalname)}"`,
      'Cache-Control': 'public, max-age=31536000, immutable',
      // CORS 헤더 추가
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.send(data.Body);
    // Body.pipe(res);

  } catch (error) {
    console.error('View file error:', error);
    res.status(500).json({
      success: false,
      message: '파일 미리보기 중 오류가 발생했습니다.',
    });
  }
};

// 파일 삭제 처리 함수
exports.deleteFile = async (req, res) => {
  try {
    await redisDataLayer.deleteFile(req.params.id);

    res.json({
      success: true,
      message: '파일이 삭제되었습니다.'
    });
  } catch (error) {
    console.error('File deletion error:', error);
    res.status(500).json({
      success: false,
      message: '파일 삭제 중 오류가 발생했습니다.',
      error: error.message
    });
  }
};

module.exports.storage = storage;