require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const http = require('http');

const { initializeFirebase } = require('./config/firebase');
const authRoutes = require('./routes/auth');
const doorRoutes = require('./routes/door');
const cameraRoutes = require('./routes/camera');
const familyRoutes = require('./routes/family');
const notificationRoutes = require('./routes/notification');
const voiceRoutes = require('./routes/voice');
const settingsRoutes = require('./routes/settings');
const { setupWebSocket } = require('./services/websocketService');

const path = require('path');

// Initialize Firebase
initializeFirebase();

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve uploaded files (family images etc.)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health check (kept under /health so root can serve the web app)
app.get('/health', (req, res) => {
    res.json({
        service: 'Doorlance Backend',
        status: 'running',
        timestamp: new Date().toISOString()
    });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/door', doorRoutes);
app.use('/api/camera', cameraRoutes);
app.use('/api/family', familyRoutes);
app.use('/api/notification', notificationRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/settings', settingsRoutes);

// Serve the built mobile-app (web) as the unified frontend
const fs = require('fs');
const webBuildDir = path.join(__dirname, '..', 'mobile-app', 'web-build');
if (fs.existsSync(webBuildDir)) {
    app.use(express.static(webBuildDir));
    // SPA fallback: anything that's not /api, /uploads, /ws or a real file -> index.html
    app.get(/^\/(?!api|uploads|ws|health).*/, (req, res, next) => {
        const indexFile = path.join(webBuildDir, 'index.html');
        if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
        next();
    });
    console.log(`Serving web app from ${webBuildDir}`);
} else {
    console.warn(`Web build not found at ${webBuildDir}. Run "npm run build:web" in mobile-app/ first.`);
    app.get('/', (req, res) => {
        res.status(503).send('Web app not built. Run: npm run build  (or: cd mobile-app && npm run build:web)');
    });
}

// WebSocket server for ESP32 and mobile app real-time communication
const wss = new WebSocketServer({ server, path: '/ws' });
setupWebSocket(wss);

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n=== Doorlance Backend ===`);
    console.log(`HTTP Server running on port ${PORT}`);
    console.log(`WebSocket Server running on ws://0.0.0.0:${PORT}/ws`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}\n`);
});
