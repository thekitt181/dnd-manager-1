
import express from 'express';
import 'dotenv/config';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';

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

if (mongoUri) {
    const client = new MongoClient(mongoUri, {
        tls: true,
        serverSelectionTimeoutMS: 5000,
        family: 4, // Force IPv4 to avoid potential IPv6 issues on some platforms
    });
    client.connect()
        .then(() => {
            console.log('Connected to MongoDB');
            const db = client.db('owlbear-extension');
            dbCollection = db.collection('data');
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
        return data || { monsters: [], items: [], deleted: [] };
    } else {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
        return { monsters: [], items: [], deleted: [] };
    }
}

// Helper to save data
async function saveData(data) {
    if (dbCollection) {
        await dbCollection.updateOne(
            { _id: 'global' },
            { $set: data },
            { upsert: true }
        );
    } else {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    }
}

// API Endpoints
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', storage: dbCollection ? 'mongodb' : 'local' });
});

app.get('/api/data', async (req, res) => {
    try {
        const data = await getData();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/data', async (req, res) => {
    try {
        const { monsters, items, deleted, images } = req.body;
        // Validate basic structure
        if (!Array.isArray(monsters) || !Array.isArray(items)) {
            return res.status(400).json({ error: 'Invalid data format' });
        }
        
        await saveData({ monsters, items, deleted: deleted || [], images: images || {}, lastUpdated: new Date() });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Image Upload Endpoint
app.post('/api/upload-image', async (req, res) => {
    try {
        const { image, filename } = req.body;
        if (!image || !image.startsWith('data:image')) {
            return res.status(400).json({ error: 'Invalid image data' });
        }

        // Extract base64 data
        const matches = image.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) {
            return res.status(400).json({ error: 'Invalid base64 string' });
        }

        const ext = matches[1];
        const data = matches[2];
        const buffer = Buffer.from(data, 'base64');
        
        const safeFilename = filename 
            ? filename.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.' + ext
            : `upload_${Date.now()}_${Math.floor(Math.random() * 1000)}.` + ext;

        const filePath = path.join(distPath, 'images/processed', safeFilename);
        
        // Ensure directory exists
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(filePath, buffer);
        
        const fileUrl = `/images/processed/${safeFilename}`;
        console.log(`Saved uploaded image to ${filePath}`);
        
        res.json({ url: fileUrl });
    } catch (err) {
        console.error("Upload failed:", err);
        res.status(500).json({ error: err.message });
    }
});

// Proxy Endpoint to bypass CORS
app.get('/api/proxy', (req, res) => {
    const { url } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    try {
        const targetUrl = new URL(url);
        const protocol = targetUrl.protocol === 'https:' ? https : http;
        
        const proxyReq = protocol.get(url, (proxyRes) => {
            // Forward status
            res.status(proxyRes.statusCode);
            
            // Forward content-type
            if (proxyRes.headers['content-type']) {
                res.setHeader('Content-Type', proxyRes.headers['content-type']);
            }
            // Ensure CORS is allowed (though global cors middleware handles this usually)
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
