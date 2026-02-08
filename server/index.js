
import express from 'express';
import 'dotenv/config';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' })); // Allow large payloads for images

// Serve static files from dist
const distPath = path.join(__dirname, '../dist');
app.use(express.static(distPath));

// MongoDB Setup
const mongoUri = process.env.MONGODB_URI;
let dbCollection = null;

if (mongoUri) {
    const client = new MongoClient(mongoUri);
    client.connect()
        .then(() => {
            console.log('Connected to MongoDB');
            const db = client.db('owlbear-extension');
            dbCollection = db.collection('data');
        })
        .catch(err => console.error('MongoDB connection error:', err));
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
        const { monsters, items, deleted } = req.body;
        // Validate basic structure
        if (!Array.isArray(monsters) || !Array.isArray(items)) {
            return res.status(400).json({ error: 'Invalid data format' });
        }
        
        await saveData({ monsters, items, deleted: deleted || [], lastUpdated: new Date() });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Serve index.html for any other route (SPA support)
app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
