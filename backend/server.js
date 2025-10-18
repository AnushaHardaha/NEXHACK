// server.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const helmet = require('helmet');
const { RateLimiterMemory } = require('rate-limiter-flexible'); // FIX: idiomatic import
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config(); // FIX: simpler, picks up .env in cwd
const cors = require('cors');

// Import custom modules
const APKAnalyzer = require('./services/apkAnalyzer');
const SecurityScanner = require('./services/securityScanner');
// const DatabaseService = require('./services/database'); // not used, can remove
const ThreatIntelligence = require('./services/threatIntelligence');

const app = express();
const PORT = process.env.PORT || 4000; // FIX: avoid collision with typical frontend dev server

app.use(cors());
app.use(express.static(path.join(__dirname, '../frontend')));


// Ensure logs directory exists BEFORE logger is created
const logsDir = path.join(__dirname, 'logs');
if (!fsSync.existsSync(logsDir)) {
  fsSync.mkdirSync(logsDir, { recursive: true });
}

// Logger configuration
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: path.join(logsDir, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(logsDir, 'combined.log') }),
    new winston.transports.Console()
  ]
});

// Rate limiting
const rateLimiter = new RateLimiterMemory({
  keyPrefix: 'apk_scan',
  points: 10,
  duration: 60
});

// Middleware
app.use(helmet());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// File upload configuration
const uploadDir = path.join(__dirname, 'uploads');
if (!fsSync.existsSync(uploadDir)) {
  fsSync.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}.apk`;
    cb(null, uniqueName);
  }
});

// FIX: accept common MIME fallback and case-insensitive extension
const upload = multer({
  storage,
  limits: {
    fileSize: 220 * 1024 * 1024,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    const okMime =
      file.mimetype === 'application/vnd.android.package-archive' ||
      file.mimetype === 'application/octet-stream';
    const okExt = name.endsWith('.apk');

    if (okMime || okExt) cb(null, true);
    else cb(new Error('Only APK files are allowed'), false);
  }
});

// Initialize services
let apkAnalyzer, securityScanner, threatIntel;

async function initializeServices() {
  try {
    apkAnalyzer = new APKAnalyzer();
    securityScanner = new SecurityScanner();
    threatIntel = new ThreatIntelligence();
    await threatIntel.initialize();
    logger.info('All services initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize services:', error);
    process.exit(1);
  }
}

// Rate limiting middleware
const rateLimitMiddleware = async (req, res, next) => {
  try {
    await rateLimiter.consume(req.ip);
    next();
  } catch (rejRes) {
    res.status(429).json({
      success: false,
      error: 'Too many requests',
      retryAfter: Math.round(rejRes.msBeforeNext) || 1000
    });
  }
};

app.post('/api/scan-apk', rateLimitMiddleware, upload.single('apk'), async (req, res) => {
  const scanId = uuidv4();
  let filePath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No APK file provided' });
    }

    filePath = req.file.path;
    const filename = req.file.originalname;
    logger.info(`Starting APK scan - ID: ${scanId}, File: ${filename}`);

    const scanResult = {
      scanId,
      filename,
      timestamp: new Date(),
      riskLevel: 'unknown',
      isFake: false,
      confidence: 0,
      threats: [],
      analysis: {},
      recommendations: []
    };

    // Step 1: Basic APK Analysis
    logger.info(`${scanId}: Starting basic APK analysis`);
    const apkInfo = await apkAnalyzer.analyzeAPK(filePath);
    scanResult.analysis.basic = apkInfo || {};

    // Step 2: Security Scanning
    logger.info(`${scanId}: Starting security scan`);
    const securityResults = await securityScanner.scanAPK(filePath, apkInfo);
    scanResult.analysis.security = securityResults || {};

    // Step 3: Banking App Detection
    logger.info(`${scanId}: Checking banking app characteristics`);
    const bankingAnalysis = await apkAnalyzer.analyzeBankingCharacteristics(filePath, apkInfo);
    scanResult.analysis.banking = bankingAnalysis || {};

    // Step 4: Threat Intelligence Check
    logger.info(`${scanId}: Running threat intelligence checks`);
    const threatResults = await threatIntel.checkAPK(apkInfo);
    scanResult.analysis.threats = threatResults || {};

    // Step 5: Machine Learning Detection (if available)
    if (process.env.ML_DETECTION_ENABLED === 'true') {
      logger.info(`${scanId}: Running ML detection`);
      const mlResults = await securityScanner.mlDetection(filePath, apkInfo);
      scanResult.analysis.ml = mlResults || {};
    }

    // Calculate final risk assessment
    const riskAssessment = calculateRiskLevel(scanResult);
    scanResult.riskLevel = riskAssessment.level;
    scanResult.isFake = riskAssessment.isFake;
    scanResult.confidence = riskAssessment.confidence;
    scanResult.threats = riskAssessment.threats;
    scanResult.recommendations = riskAssessment.recommendations;

    logger.info(`${scanId}: Scan completed - Risk: ${scanResult.riskLevel}, Fake: ${scanResult.isFake}`);

    res.json({
      success: true,
      scanId,
      result: {
        riskLevel: scanResult.riskLevel,
        isFake: scanResult.isFake,
        confidence: scanResult.confidence,
        threats: scanResult.threats,
        recommendations: scanResult.recommendations,
        summary: generateScanSummary(scanResult)
      }
    });
  } catch (error) {
    logger.error(`${scanId}: Scan failed: ${error.message}`, { stack: error.stack });
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        scanId,
        error: 'Scan failed',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
      });
    }
  } finally {
    if (filePath) {
      try {
        await fs.unlink(filePath);
      } catch (cleanupError) {
        logger.error(`Failed to cleanup file ${filePath}:`, cleanupError);
      }
    }
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date(),
    services: {
      threatIntel: threatIntel ? 'initialized' : 'not initialized'
    }
  });
});

// FIX: make this robust to missing fields
function calculateRiskLevel(scanResult) {
  const basic = scanResult.analysis?.basic || {};

  const securityDefaults = {
    maliciousPermissions: 0,
    suspiciousStrings: 0,
    obfuscated: false,
    packedExecutables: 0
  };
  const security = { ...securityDefaults, ...(scanResult.analysis?.security || {}) };

  const bankingDefaults = {
    imitatesBankingApp: false,
    hasPhishingIndicators: false,
    suspiciousNetworking: false
  };
  const banking = { ...bankingDefaults, ...(scanResult.analysis?.banking || {}) };

  const threatDefaults = { knownMalware: false, suspiciousDomains: 0 };
  const threats = { ...threatDefaults, ...(scanResult.analysis?.threats || {}) };

  const mlDefaults = { malwareProbability: 0 };
  const ml = { ...mlDefaults, ...(scanResult.analysis?.ml || {}) };

  let riskScore = 0;
  let confidence = 0;
  const detectedThreats = [];
  const recommendations = [];

  // Basic APK analysis scoring
  if (basic.isDebuggable) riskScore += 10;
  if (basic.allowBackup) riskScore += 5;
  if (basic.hasNativeCode) riskScore += 5;

  // Security analysis scoring
  if (security.maliciousPermissions > 0) riskScore += security.maliciousPermissions * 15;
  if (security.suspiciousStrings > 0) riskScore += security.suspiciousStrings * 10;
  if (security.obfuscated) riskScore += 20;
  if (security.packedExecutables > 0) riskScore += security.packedExecutables * 25;

  // Banking characteristics scoring
  if (banking.imitatesBankingApp) {
    riskScore += 50;
    detectedThreats.push('Banking app impersonation detected');
  }
  if (banking.hasPhishingIndicators) {
    riskScore += 40;
    detectedThreats.push('Phishing indicators found');
  }
  if (banking.suspiciousNetworking) {
    riskScore += 30;
    detectedThreats.push('Suspicious network behavior');
  }

  // Threat intelligence scoring
  if (threats.knownMalware) {
    riskScore += 100;
    detectedThreats.push('Known malware signature detected');
  }
  if (threats.suspiciousDomains > 0) {
    riskScore += threats.suspiciousDomains * 20;
    detectedThreats.push('Communicates with suspicious domains');
  }

  // ML detection scoring (if available)
  if (ml && ml.malwareProbability > 0.7) {
    riskScore += ml.malwareProbability * 50;
    detectedThreats.push('AI-based malware detection triggered');
  }

  // Determine risk level and fake status
  let level, isFake;
  if (riskScore >= 80) {
    level = 'critical';
    isFake = true;
    confidence = Math.min(95, 70 + riskScore * 0.3);
  } else if (riskScore >= 50) {
    level = 'high';
    isFake = riskScore >= 60;
    confidence = Math.min(85, 60 + riskScore * 0.4);
  } else if (riskScore >= 25) {
    level = 'medium';
    isFake = false;
    confidence = Math.min(75, 50 + riskScore * 0.5);
  } else if (riskScore >= 10) {
    level = 'low';
    isFake = false;
    confidence = Math.min(65, 40 + riskScore * 0.6);
  } else {
    level = 'minimal';
    isFake = false;
    confidence = Math.min(60, 30 + riskScore);
  }

  if (isFake) {
    recommendations.push('DO NOT INSTALL - This appears to be a fake banking application');
    recommendations.push('Report this APK to your bank and security authorities');
  }
  if (security.maliciousPermissions > 0) {
    recommendations.push('Review app permissions carefully before installation');
  }
  if (banking.suspiciousNetworking) {
    recommendations.push('This app may transmit sensitive data to unauthorized servers');
  }

  return {
    level,
    isFake,
    confidence: Math.round(confidence),
    threats: detectedThreats,
    recommendations
  };
}

function generateScanSummary(scanResult) {
  const { riskLevel, isFake, threats } = scanResult;
  if (isFake) {
    return `DANGER: This APK appears to be a fake banking application with ${riskLevel} risk level. ${threats.length} threats detected.`;
  } else {
    return `This APK appears legitimate with ${riskLevel} risk level. ${threats.length} potential issues found.`;
  }
}

// Multer-aware error handler (400 for bad uploads)
app.use((err, req, res, next) => {
  if (err && (err.name === 'MulterError' || err.message === 'Only APK files are allowed')) {
    return res.status(400).json({
      success: false,
      error: err.message
    });
  }
  return next(err);
});

// Fallback error handler
app.use((error, req, res, next) => {
  logger.error('Unhandled error:', error);
  if (res.headersSent) return next(error);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start server
async function startServer() {
  await initializeServices();
  app.listen(PORT, () => {
    logger.info(`APK Security Scanner running on port ${PORT}`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

startServer().catch(error => {
  logger.error('Failed to start server:', error);
  process.exit(1);
});

module.exports = app;