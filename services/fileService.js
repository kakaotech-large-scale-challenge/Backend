const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Readable } = require('stream');
const pdfParse = require('pdf-parse');

// AWS S3 설정
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME;

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

exports.processFileForRAG = async (s3Key) => {
  let textContent = '';
  try{
    // S3에서 파일 가져오기
    const params = {
      Bucket: BUCKET_NAME,
      Key: s3Key,
    };
    const command = new GetObjectCommand(params);
    const { Body, ContentType } = await s3.send(command);

    // 파일 유형 확인
    if (ContentType === 'application/pdf') {
      // PDF 파일 처리
      const pdfBuffer = await streamToString(Body);
      const pdfData = await pdfParse(pdfBuffer);
      textContent = pdfData.text;
    } else if (ContentType === 'text/plain') {
      // 텍스트 파일 처리
      textContent = await streamToString(Body);
    } else {
      throw new Error('지원하지 않는 파일 형식입니다: ${ContentType}');
    }

    // 텍스트를 벡터화하여 벡터 DB에 저장
    await vectorDB.storeDocument(textContent);
    console.log('문서가 성공적으로 처리되었습니다.');
  }catch(error){
    console.error('파일 처리 중 오류 발생:', error);
    throw error;
  }
};