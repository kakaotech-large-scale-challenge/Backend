// backend/routes/api/files.js
const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const fileController = require('../../controllers/fileController');
const { upload, errorHandler } = require('../../middleware/upload');

// 파일 업로드
router.post('/upload',
  auth,
  upload.single('file'),
  errorHandler,
  fileController.uploadFile
);

// 파일 다운로드
router.get('/download/:filename',
  auth,
  fileController.downloadFile
);

// 파일 보기 (미리보기용)
router.get('/view/:filename',
  auth,
  (req, res, next) => {
    console.log('확인', req.params);  // 여기서 req.params를 출력
    next();  // 다음 미들웨어로 넘어가기 위해 next() 호출
  },
  fileController.viewFile
);

// 파일 삭제
router.delete('/:id',
  auth,
  fileController.deleteFile
);

module.exports = router;