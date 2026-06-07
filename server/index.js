
import express from 'express';
import 'dotenv/config';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';
import axios from 'axios';
import FormData from 'form-data';
import multer from 'multer';

const upload = multer({ storage: multer.memoryStorage() });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' })); // Allow large payloads for images

// Serve static files from dist
const distPath = path.join(__dirname, '../dist');
app.use(express.static(distPath));

// MongoDB Setup
const mongoUri = process.env.MONGODB_URI;
let dbCollection = null;
const sseClients = new Set();

function broadcastDataUpdate(lastUpdated) {
    const payload = JSON.stringify({
        type: 'update',
        lastUpdated: lastUpdated ? new Date(lastUpdated).toISOString() : null,
    });
    for (const client of sseClients) {
        client.write(`data: ${payload}\n\n`);
    }
}

if (mongoUri) {
    const client = new MongoClient(mongoUri, {
        serverSelectionTimeoutMS: 5000,
        family: 4, // Force IPv4 to avoid potential IPv6 issues on some platforms
    });
    client.connect()
        .then(() => {
            console.log('Connected to MongoDB');
            const db = client.db('owlbear-extension');
            dbCollection = db.collection('data');

            const changeStream = dbCollection.watch(
                [{ $match: { 'documentKey._id': 'global' } }],
                { fullDocument: 'updateLookup' }
            );

            changeStream.on('change', (change) => {
                const lastUpdated = change.fullDocument?.lastUpdated || new Date();
                console.log('MongoDB data changed, broadcasting to clients');
                broadcastDataUpdate(lastUpdated);
            });

            changeStream.on('error', (err) => {
                console.error('MongoDB change stream error:', err);
            });
        })
        .catch(err => {
            console.error('MongoDB connection error:', err);
            console.error('If you are using MongoDB Atlas, please check your Network Access (IP Whitelist) settings.');
        });
}

// Fallback to local file if no DB (Ephemeral on Render!)
const DATA_FILE = path.join(__dirname, 'data.json');

// Helper to get data
async function getData() {
    if (dbCollection) {
        const data = await dbCollection.findOne({ _id: 'global' });
        return data || {
            monsters: [], items: [], spells: [],
            overrideMonsters: [], overrideItems: [], overrideSpells: [],
            deleted: [], images: {}, imagesData: {}, entryImages: {},
            extractedMonsters: [], extractedItems: [],
        };
    } else {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
        return { monsters: [], items: [], deleted: [] };
    }
}

// Fetch a single stored image without loading the full library document
async function getImageByKey(key) {
    if (dbCollection) {
        const doc = await dbCollection.findOne(
            { _id: 'global' },
            { projection: { [`images.${key}`]: 1, [`imagesData.${key}`]: 1 } }
        );
        return {
            pathOrUrl: doc?.images?.[key] ?? null,
            rawData: doc?.imagesData?.[key] ?? null,
        };
    }

    const data = await getData();
    return {
        pathOrUrl: data.images?.[key] ?? null,
        rawData: data.imagesData?.[key] ?? null,
    };
}

async function storeImageByKey(key, imageData) {
    const staticRef = `/api/static-image?key=${encodeURIComponent(key)}`;
    const now = new Date();

    if (dbCollection) {
        await dbCollection.updateOne(
            { _id: 'global' },
            {
                $set: {
                    [`images.${key}`]: staticRef,
                    [`imagesData.${key}`]: imageData,
                    lastUpdated: now,
                },
            },
            { upsert: true }
        );
        broadcastDataUpdate(now);
        return { url: staticRef, key, storage: 'mongodb' };
    }

    const existing = fs.existsSync(DATA_FILE)
        ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
        : {
            monsters: [], items: [], spells: [],
            overrideMonsters: [], overrideItems: [], overrideSpells: [],
            deleted: [], images: {}, imagesData: {}, entryImages: {},
        };
    if (!existing.images) existing.images = {};
    if (!existing.imagesData) existing.imagesData = {};
    existing.images[key] = staticRef;
    existing.imagesData[key] = imageData;
    existing.lastUpdated = now.toISOString();
    fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2));
    broadcastDataUpdate(now);
    return { url: staticRef, key, storage: 'local' };
}

async function deleteImageByKey(key) {
    const now = new Date();

    if (dbCollection) {
        await dbCollection.updateOne(
            { _id: 'global' },
            {
                $unset: {
                    [`images.${key}`]: '',
                    [`imagesData.${key}`]: '',
                },
                $set: { lastUpdated: now },
            }
        );
        broadcastDataUpdate(now);
        return { key, storage: 'mongodb' };
    }

    if (fs.existsSync(DATA_FILE)) {
        const existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (existing.images) delete existing.images[key];
        if (existing.imagesData) delete existing.imagesData[key];
        existing.lastUpdated = now.toISOString();
        fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2));
    }
    broadcastDataUpdate(now);
    return { key, storage: 'local' };
}

function namesMatch(a, b) {
    if (!a || !b) return false;
    return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function dedupeByEntryName(entries) {
    const map = new Map();
    for (const entry of entries || []) {
        if (!entry?.name) continue;
        map.set(String(entry.name).trim().toLowerCase(), entry);
    }
    return Array.from(map.values());
}

function normalizeLibraryData(data) {
    const overrideMonsters = dedupeByEntryName(data.overrideMonsters);
    const overrideItems = dedupeByEntryName(data.overrideItems);
    const overrideSpells = dedupeByEntryName(data.overrideSpells);
    let deleted = Array.isArray(data.deleted) ? [...data.deleted] : [];

    const ensureDeleted = (name) => {
        if (!name) return;
        if (!deleted.some((entry) => namesMatch(entry, name))) {
            deleted.push(String(name).trim());
        }
    };

    for (const override of [...overrideMonsters, ...overrideItems, ...overrideSpells]) {
        if (override.originBookName && !namesMatch(override.originBookName, override.name)) {
            ensureDeleted(override.originBookName);
        }
    }

    const filterCustom = (customs, overrides) => {
        const overrideNames = new Set(
            overrides.map((entry) => String(entry.name).trim().toLowerCase())
        );
        const originNames = new Set(
            overrides
                .filter((entry) => entry.originBookName)
                .map((entry) => String(entry.originBookName).trim().toLowerCase())
        );
        const deletedNames = new Set(
            deleted.map((entry) => String(entry).trim().toLowerCase())
        );

        return (customs || []).filter((entry) => {
            if (!entry?.name) return false;
            const name = String(entry.name).trim().toLowerCase();
            if (overrideNames.has(name)) return false;
            if (originNames.has(name)) return false;
            if (deletedNames.has(name)) return false;
            if (entry.originBookName) return false;
            return true;
        });
    };

    return {
        monsters: filterCustom(data.monsters, overrideMonsters),
        items: filterCustom(data.items, overrideItems),
        spells: filterCustom(data.spells, overrideSpells),
        deleted,
        overrideMonsters,
        overrideItems,
        overrideSpells,
        images: data.images || {},
        imagesData: data.imagesData || {},
        entryImages: data.entryImages || {},
        extractedMonsters: Array.isArray(data.extractedMonsters) ? data.extractedMonsters : [],
        extractedItems: Array.isArray(data.extractedItems) ? data.extractedItems : [],
    };
}

// Helper to save data — client sends a full snapshot of library data
async function saveData(data) {
    const existing = await getData();
    const incoming = normalizeLibraryData({
        monsters: Array.isArray(data.monsters) ? data.monsters : (existing.monsters || []),
        items: Array.isArray(data.items) ? data.items : (existing.items || []),
        spells: Array.isArray(data.spells) ? data.spells : (existing.spells || []),
        deleted: Array.isArray(data.deleted) ? data.deleted : (existing.deleted || []),
        overrideMonsters: Array.isArray(data.overrideMonsters) ? data.overrideMonsters : (existing.overrideMonsters || []),
        overrideItems: Array.isArray(data.overrideItems) ? data.overrideItems : (existing.overrideItems || []),
        overrideSpells: Array.isArray(data.overrideSpells) ? data.overrideSpells : (existing.overrideSpells || []),
        images: data.images !== undefined ? data.images : (existing.images || {}),
        imagesData: data.imagesData !== undefined ? data.imagesData : (existing.imagesData || {}),
        entryImages: data.entryImages !== undefined ? data.entryImages : (existing.entryImages || {}),
        extractedMonsters: Array.isArray(data.extractedMonsters) ? data.extractedMonsters : (existing.extractedMonsters || []),
        extractedItems: Array.isArray(data.extractedItems) ? data.extractedItems : (existing.extractedItems || []),
    });

    const activeImageKeys = new Set(Object.keys(incoming.images || {}));
    const mergedImagesData = { ...(existing.imagesData || {}), ...(incoming.imagesData || {}) };
    const prunedImagesData = {};
    for (const [key, value] of Object.entries(mergedImagesData)) {
        if (activeImageKeys.has(key)) prunedImagesData[key] = value;
    }

    const payload = {
        monsters: incoming.monsters,
        items: incoming.items,
        spells: incoming.spells,
        deleted: incoming.deleted,
        overrideMonsters: incoming.overrideMonsters,
        overrideItems: incoming.overrideItems,
        overrideSpells: incoming.overrideSpells,
        images: { ...(incoming.images || {}) },
        imagesData: prunedImagesData,
        entryImages: { ...(incoming.entryImages || {}) },
        extractedMonsters: incoming.extractedMonsters,
        extractedItems: incoming.extractedItems,
        lastUpdated: new Date(),
    };

    if (dbCollection) {
        await dbCollection.updateOne(
            { _id: 'global' },
            { $set: payload },
            { upsert: true }
        );
    } else {
        fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
    }
    broadcastDataUpdate(payload.lastUpdated);
    return payload;
}

// API Endpoints
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', storage: dbCollection ? 'mongodb' : 'local' });
});

app.get('/api/data', async (req, res) => {
    try {
        const data = await getData();
        const normalized = normalizeLibraryData(data);
        res.json({
            ...data,
            monsters: normalized.monsters,
            items: normalized.items,
            spells: normalized.spells,
            deleted: normalized.deleted,
            overrideMonsters: normalized.overrideMonsters,
            overrideItems: normalized.overrideItems,
            overrideSpells: normalized.overrideSpells,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/data/version', async (req, res) => {
    try {
        if (dbCollection) {
            const doc = await dbCollection.findOne(
                { _id: 'global' },
                { projection: { lastUpdated: 1 } }
            );
            return res.json({
                lastUpdated: doc?.lastUpdated ? new Date(doc.lastUpdated).toISOString() : null,
                storage: 'mongodb',
            });
        }

        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            return res.json({
                lastUpdated: data.lastUpdated ? new Date(data.lastUpdated).toISOString() : null,
                storage: 'local',
            });
        }

        res.json({ lastUpdated: null, storage: 'local' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/data/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    sseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
    }, 30000);

    req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
    });
});

app.post('/api/data', async (req, res) => {
    try {
        const {
            monsters, items, spells,
            overrideMonsters, overrideItems, overrideSpells,
            deleted, images, imagesData, entryImages,
            extractedMonsters, extractedItems,
        } = req.body;
        // Validate basic structure
        if (!Array.isArray(monsters) || !Array.isArray(items)) {
            return res.status(400).json({ error: 'Invalid data format' });
        }
        
        const saved = await saveData({
            monsters,
            items,
            spells: Array.isArray(spells) ? spells : [],
            overrideMonsters: Array.isArray(overrideMonsters) ? overrideMonsters : [],
            overrideItems: Array.isArray(overrideItems) ? overrideItems : [],
            overrideSpells: Array.isArray(overrideSpells) ? overrideSpells : [],
            deleted: deleted || [],
            images: images || {},
            imagesData: imagesData || {},
            entryImages: entryImages || {},
            extractedMonsters: Array.isArray(extractedMonsters) ? extractedMonsters : [],
            extractedItems: Array.isArray(extractedItems) ? extractedItems : [],
        });
        res.json({
            success: true,
            lastUpdated: saved.lastUpdated ? new Date(saved.lastUpdated).toISOString() : null,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Image Upload Endpoint
app.post('/api/upload-image', async (req, res) => {
    try {
        const { image, filename, folder } = req.body;
        if (!image || !image.startsWith('data:image')) {
            return res.status(400).json({ error: 'Invalid image data' });
        }

        // Extract base64 data
        const matches = image.match(/^data:image\/([a-zA-Z0-9+\.-]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) {
            return res.status(400).json({ error: 'Invalid base64 string' });
        }

        let ext = matches[1];
        // Fix for svg+xml mime type -> .svg extension
        if (ext === 'svg+xml') {
            ext = 'svg';
        }
        
        const data = matches[2];
        const buffer = Buffer.from(data, 'base64');
        
        // Determine target paths
        const safeFilename = filename 
            ? filename.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.' + ext
            : `upload_${Date.now()}_${Math.floor(Math.random() * 1000)}.` + ext;

        let relativeUrl;
        
        if (folder) {
            // "Smart" save: Save to source (public) AND runtime (dist)
            const safeFolder = folder.replace(/[^a-z0-9]/gi, '_').toLowerCase();
            const relativePath = `images/${safeFolder}/${safeFilename}`;
            
            const publicPath = path.join(__dirname, '../public', relativePath);
            const runtimePath = path.join(distPath, relativePath);

            // 1. Save to Public (Source of Truth)
            const publicDir = path.dirname(publicPath);
            if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
            fs.writeFileSync(publicPath, buffer);
            console.log(`Saved to source: ${publicPath}`);

            // 2. Save to Dist (Runtime)
            const runtimeDir = path.dirname(runtimePath);
            if (!fs.existsSync(runtimeDir)) fs.mkdirSync(runtimeDir, { recursive: true });
            fs.writeFileSync(runtimePath, buffer);
            console.log(`Saved to runtime: ${runtimePath}`);

            relativeUrl = '/' + relativePath;
        } else {
            // Default behavior: Save to processed folder in dist only
            const filePath = path.join(distPath, 'images/processed', safeFilename);
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, buffer);
            
            relativeUrl = `/images/processed/${safeFilename}`;
            console.log(`Saved uploaded image to ${filePath}`);
        }
        
        res.json({ url: relativeUrl });
    } catch (err) {
        console.error("Upload failed:", err);
        res.status(500).json({ error: err.message });
    }
});

// Proxy Endpoint to bypass CORS (GET)
app.get('/api/proxy', (req, res) => {
    const { url } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    try {
        const targetUrl = new URL(url);
        const protocol = targetUrl.protocol === 'https:' ? https : http;
        
        const proxyReq = protocol.get(url, (proxyRes) => {
            res.status(proxyRes.statusCode);
            if (proxyRes.headers['content-type']) {
                res.setHeader('Content-Type', proxyRes.headers['content-type']);
            }
            res.setHeader('Access-Control-Allow-Origin', '*');
            proxyRes.pipe(res);
        }).on('error', (e) => {
            console.error(`Proxy error for ${url}:`, e);
            res.status(500).json({ error: 'Proxy request failed', details: e.message });
        });
        
    } catch (e) {
        res.status(400).json({ error: 'Invalid URL', details: e.message });
    }
});

// Proxy Endpoint to bypass CORS (POST) - for AI API
app.post('/api/proxy', async (req, res) => {
    const { url, ...body } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    try {
        console.log(`Proxying POST request to ${url}`);
        const response = await axios.post(url, body, {
            headers: {
                'Content-Type': 'application/json'
            }
        });
        console.log(`Proxy response status: ${response.status}`);
        res.status(response.status).json(response.data);
    } catch (e) {
        console.error(`POST proxy error for ${url}:`, e.message);
        if (e.response) {
            console.error('Response data:', e.response.data);
            res.status(e.response.status).json(e.response.data);
        } else {
            res.status(500).json({ error: 'Proxy request failed', details: e.message });
        }
    }
});

// PhotoRoom Background Removal API
app.post('/api/remove-background', upload.single('image'), async (req, res) => {
  console.log('=== PhotoRoom Request Received ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('File info:', req.file ? { 
    originalname: req.file.originalname, 
    mimetype: req.file.mimetype, 
    size: req.file.size 
  } : 'NO FILE!');

  try {
    if (!req.file) {
      console.error('No image file provided');
      return res.status(400).json({ error: 'No image file provided.' });
    }

    console.log('Calling PhotoRoom API...');

    const form = new FormData();
    form.append('image_file', req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype || 'image/png',
    });

    console.log('Form data prepared, sending to PhotoRoom...');
    const response = await axios.post(
      'https://sdk.photoroom.com/v1/segment',
      form,
      {
        headers: {
          ...form.getHeaders(),
          'x-api-key': 'sk_pr_default_c4f0cde55db80941f4b37d3d61d99cc851ba151f'
        },
        responseType: 'arraybuffer',
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120000, // 2 min timeout
      }
    );

    console.log('PhotoRoom response status:', response.status);
    console.log('PhotoRoom response headers:', response.headers);

    res.set('Content-Type', 'image/png');
    res.send(response.data);
  } catch (err) {
    console.error('=== PhotoRoom Error ===');
    console.error('Error message:', err.message);
    if (err.response) {
      console.error('Response status:', err.response.status);
      console.error('Response status text:', err.response.statusText);
      console.error('Response headers:', err.response.headers);
      if (err.response.data) {
        try {
          // Try to parse as text first
          console.error('Response data:', err.response.data.toString());
        } catch (e) {
          console.error('Response data (raw):', err.response.data);
        }
      }
    } else if (err.request) {
      console.error('No response received from PhotoRoom');
    }
    res.status(500).json({ 
      error: 'Background removal failed', 
      message: err.message,
      status: err.response?.status,
      statusText: err.response?.statusText
    });
  }
});

// D&D PDF Extraction using base44.app API (disabled for now)
app.post('/api/extract-dnd-pdf', upload.single('pdf'), async (req, res) => {
  try {
    let pdfBase64;
    let filename;

    if (req.file) {
      pdfBase64 = req.file.buffer.toString('base64');
      filename = req.file.originalname;
    } else if (req.body && req.body.pdf_base64) {
      pdfBase64 = req.body.pdf_base64;
      filename = req.body.filename || 'unknown.pdf';
    } else {
      return res.status(400).json({ error: 'No PDF file provided.' });
    }

    console.log('Calling base44.app with base64 (fallback)...');

    const response = await axios.post(
      'https://6a121fa69e999d7758780e21.base44.app/functions/extractDndPdf',
      { pdf_base64: pdfBase64 },
      {
        headers: { 'Content-Type': 'application/json' },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120000, // 2 min timeout for large PDFs
      }
    );

    res.json(response.data);
  } catch (err) {
    console.error('DnD PDF extraction error:', err?.response?.data || err.message);
    res.status(500).json({ error: err?.response?.data?.error || err.message });
  }
});

app.delete('/api/store-image', async (req, res) => {
    try {
        const key = req.query.key;
        if (!key || typeof key !== 'string') {
            return res.status(400).json({ error: 'Missing key parameter' });
        }
        const result = await deleteImageByKey(key);
        res.json({
            ...result,
            lastUpdated: new Date().toISOString(),
        });
    } catch (err) {
        console.error('delete store-image error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Store a single image in MongoDB/local storage by key (avoids localStorage quota on clients)
app.post('/api/store-image', async (req, res) => {
    try {
        const { key, imageData } = req.body;
        if (!key || typeof key !== 'string') {
            return res.status(400).json({ error: 'Missing key parameter' });
        }
        if (!imageData || typeof imageData !== 'string' || !imageData.startsWith('data:image')) {
            return res.status(400).json({ error: 'Invalid image data' });
        }
        const result = await storeImageByKey(key, imageData.replace(/\s/g, ''));
        res.json({
            ...result,
            lastUpdated: new Date().toISOString(),
        });
    } catch (err) {
        console.error('store-image error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Serve persisted images from DB or fallback
app.get('/api/static-image', async (req, res) => {
    try {
        const key = req.query.key;
        if (!key) return res.status(400).json({ error: 'Missing key parameter' });
        const { pathOrUrl, rawData } = await getImageByKey(key);
        
        // 1) If we have a file path under dist, serve that
        if (pathOrUrl && pathOrUrl.startsWith('/images/')) {
            const filePath = path.join(distPath, pathOrUrl.replace(/^\//, ''));
            if (fs.existsSync(filePath)) {
                return res.sendFile(filePath);
            }
        }
        
        // 2) If we have raw Data URI, decode and serve
        if (rawData && rawData.startsWith('data:image')) {
            const matches = rawData.match(/^data:image\/([a-zA-Z0-9+\.-]+);base64,(.+)$/);
            if (!matches || matches.length !== 3) {
                return res.status(400).json({ error: 'Invalid stored image data' });
            }
            let ext = matches[1];
            if (ext === 'svg+xml') ext = 'svg';
            const base64 = matches[2];
            const buffer = Buffer.from(base64, 'base64');
            res.setHeader('Content-Type', `image/${ext}`);
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            res.setHeader('Access-Control-Allow-Origin', '*');
            return res.end(buffer);
        }
        
        // 3) If we have a full external URL, proxy it
        if (pathOrUrl && /^https?:\/\//.test(pathOrUrl)) {
            try {
                const targetUrl = new URL(pathOrUrl);
                const protocol = targetUrl.protocol === 'https:' ? https : http;
                protocol.get(pathOrUrl, (proxyRes) => {
                    res.status(proxyRes.statusCode);
                    if (proxyRes.headers['content-type']) {
                        res.setHeader('Content-Type', proxyRes.headers['content-type']);
                    }
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    proxyRes.pipe(res);
                }).on('error', (e) => {
                    console.error('Static-image proxy error:', e);
                    res.status(500).json({ error: 'Proxy failed' });
                });
                return;
            } catch (e) {
                // fall through
            }
        }
        
        return res.status(404).json({ error: 'Image not found' });
    } catch (e) {
        console.error('static-image error:', e);
        return res.status(500).json({ error: e.message });
    }
});

// Return 404 for missing images instead of index.html to prevent valid 200 OK HTML responses for images
app.get('/images/*', (req, res) => {
    res.status(404).send('Image not found');
});

// Serve index.html for any other route (SPA support)
app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
