// controllers/health.js

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose'); // 데이터베이스 연결을 위한 모듈

router.get('/', async (req, res) => {
    try {
        const dbState = mongoose.connection.readyState;
        console.log('Current MongoDB connection state:', dbState);
        
        // MongoDB connection states
        const states = {
            0: 'disconnected',
            1: 'connected',
            2: 'connecting',
            3: 'disconnecting'
        };
        console.log('Connection status:', states[dbState]);

        if (dbState === 1) {
            res.status(200).send('OK');
        } else {
            console.log('Database not fully connected. Current state:', states[dbState]);
            throw new Error('Database not connected');
        }
    } catch (err) {
        // 문제가 있으면 500 반환
        res.status(500).send('Unhealthy');
    }
});

module.exports = router;