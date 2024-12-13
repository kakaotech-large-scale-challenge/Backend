const AWS = require('aws-sdk'); // 이 라인 추가
const bcrypt = require('bcryptjs');
// const User = require('../models/User');
const { upload } = require('../middleware/upload');
const path = require('path');
const fs = require('fs').promises;

// S3 설정
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME;

// 회원가입 처리 함수
exports.register = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // 입력값 유효성 검사
    const validationErrors = [];
    
    // 이름 검증
    if (!name || name.trim().length === 0) {
      validationErrors.push({
        field: 'name',
        message: '이름을 입력해주세요.'
      });
    } else if (name.length < 2) {
      validationErrors.push({
        field: 'name',
        message: '이름은 2자 이상이어야 합니다.'
      });
    }

    // 이메일 검증
    if (!email) {
      validationErrors.push({
        field: 'email',
        message: '이메일을 입력해주세요.'
      });
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      validationErrors.push({
        field: 'email',
        message: '올바른 이메일 형식이 아닙니다.'
      });
    }

    // 비밀번호 검증
    if (!password) {
      validationErrors.push({
        field: 'password',
        message: '비밀번호를 입력해주세요.'
      });
    } else if (password.length < 6) {
      validationErrors.push({
        field: 'password',
        message: '비밀번호는 6자 이상이어야 합니다.'
      });
    }

    // 유효성 검사 실패 시 에러 반환
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        errors: validationErrors
      });
    }

    // 이메일 중복 확인
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: '이미 가입된 이메일입니다.'
      });
    }

    // 새로운 사용자 객체 생성
    const newUser = new User({ 
      name, 
      email, 
      password,
      profileImage: '' // 기본 프로필 이미지 없음
    });

    // 비밀번호 암호화 및 사용자 저장
    const salt = await bcrypt.genSalt(10);
    newUser.password = await bcrypt.hash(password, salt);
    await newUser.save();

    // 성공 응답 반환
    res.status(201).json({
      success: true,
      message: '회원가입이 완료되었습니다.',
      user: {
        id: newUser._id,
        name: newUser.name,
        email: newUser.email,
        profileImage: newUser.profileImage
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: '회원가입 처리 중 오류가 발생했습니다.'
    });
  }
};

// 사용자 프로필 조회 함수
exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        profileImageUrl: user.profileImage // S3 URL
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      message: '프로필 조회 중 오류가 발생했습니다.'
    });
  }
};

// 프로필 정보 업데이트 함수
exports.updateProfile = async (req, res) => {
  try {
    const { name } = req.body;

    // 이름 유효성 검사
    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: '이름을 입력해주세요.'
      });
    }

    // 사용자 조회
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    // 이름 업데이트 및 저장
    user.name = name.trim();
    await user.save();

    // 업데이트된 정보 반환
    res.json({
      success: true,
      message: '프로필이 업데이트되었습니다.',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        profileImage: user.profileImage
      }
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: '프로필 업데이트 중 오류가 발생했습니다.'
    });
  }
};

// 프로필 이미지 업로드 함수
exports.uploadProfileImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: '이미지가 제공되지 않았습니다.'
      });
    }

    // 파일 크기 및 타입 검증
    const fileSize = req.file.size;
    const fileType = req.file.mimetype;
    const maxSize = 5 * 1024 * 1024; // 5MB

    if (fileSize > maxSize) {
      await s3.deleteObject({
        Bucket: BUCKET_NAME,
        Key: req.file.key
      }).promise();
      
      return res.status(400).json({
        success: false,
        message: '파일 크기는 5MB를 초과할 수 없습니다.'
      });
    }

    if (!fileType.startsWith('image/')) {
      await s3.deleteObject({
        Bucket: BUCKET_NAME,
        Key: req.file.key
      }).promise();

      return res.status(400).json({
        success: false,
        message: '이미지 파일만 업로드할 수 있습니다.'
      });
    }

    // S3 업로드 성공 시 URL과 Key 반환
    res.json({
      success: true,
      message: '프로필 이미지가 업로드되었습니다.',
      imageUrl: req.file.location,
      imageKey: req.file.key
    });

  } catch (error) {
    console.error('Profile image upload error:', error);
    if (req.file) {
      try {
        await s3.deleteObject({
          Bucket: BUCKET_NAME,
          Key: req.file.key
        }).promise();
      } catch (deleteError) {
        console.error('File delete error:', deleteError);
      }
    }
    res.status(500).json({
      success: false,
      message: '이미지 업로드 중 오류가 발생했습니다.'
    });
  }
};

// 프로필 이미지 삭제 함수
exports.deleteProfileImage = async (req, res) => {
  try {
    const { key } = req.body; // 클라이언트에서 전달받은 이미지 키

    if (!key) {
      return res.status(400).json({
        success: false,
        message: '이미지 키가 제공되지 않았습니다.'
      });
    }

    await s3.deleteObject({
      Bucket: BUCKET_NAME,
      Key: key
    }).promise();

    res.json({
      success: true,
      message: '프로필 이미지가 삭제되었습니다.'
    });

  } catch (error) {
    console.error('Delete profile image error:', error);
    res.status(500).json({
      success: false,
      message: '프로필 이미지 삭제 중 오류가 발생했습니다.'
    });
  }
};


// 회원 탈퇴 처리 함수
exports.deleteAccount = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    if (user.profileImageKey) {
      try {
        await s3.deleteObject({
          Bucket: BUCKET_NAME,
          Key: user.profileImageKey
        }).promise();
      } catch (error) {
        console.error('Profile image delete error:', error);
      }
    }

    await user.deleteOne();

    res.json({
      success: true,
      message: '회원 탈퇴가 완료되었습니다.'
    });

  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({
      success: false,
      message: '회원 탈퇴 처리 중 오류가 발생했습니다.'
    });
  }
};

module.exports = exports;