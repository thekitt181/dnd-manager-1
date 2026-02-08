import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Canvas = require('canvas');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = path.join(__dirname, '../public/images');
const TRASH_DIR = path.join(__dirname, '../public/images_trash');
const MONSTERS_FILE = path.join(__dirname, '../src/monsters.json');

if (!fs.existsSync(TRASH_DIR)) {
    fs.mkdirSync(TRASH_DIR, { recursive: true });
}

async function processImage(file) {
    const filePath = path.join(IMAGES_DIR, file);
    if (!fs.existsSync(filePath)) return { action: 'skip' };

    let img;
    try {
        img = await Canvas.loadImage(filePath);
    } catch (e) {
        console.log(`Error loading ${file}: ${e.message}`);
        // If image is corrupt, delete it
        if (e.message.includes('Unsupported image type') || e.message.includes('corrupt')) {
             return { action: 'delete', reason: 'Corrupt/Unsupported' };
        }
        return { action: 'error' };
    }

    if (img.width < 50 || img.height < 50) {
        return { action: 'delete', reason: 'Too small' };
    }

    const canvas = Canvas.createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const imageData = ctx.getImageData(0, 0, img.width, img.height);
    const data = imageData.data;
    
    // Stats
    let r=0, g=0, b=0;
    let count = 0;
    let transparent = 0;
    let white = 0;
    let black = 0;
    let parchment = 0;
    const step = 40; // Sample rate

    for (let i = 0; i < data.length; i += step) {
        const dr = data[i];
        const dg = data[i+1];
        const db = data[i+2];
        const da = data[i+3];

        r += dr; g += dg; b += db;
        count++;

        if (da < 10) transparent++;
        else {
            // Strict White/Black
            if (dr > 240 && dg > 240 && db > 240) white++;
            else if (dr < 15 && dg < 15 && db < 15) black++;
            
            // Parchment detection (relaxed)
            if (dr > 160 && dg > 140 && db > 110 && dr > db + 10) parchment++;
        }
    }

    const avgR = r / count;
    
    // Variance (StdDev)
    let varSum = 0;
    for (let i = 0; i < data.length; i += step) {
        varSum += Math.pow(data[i] - avgR, 2);
    }
    const stdDev = Math.sqrt(varSum / count);

    const tRatio = transparent / count;
    const wRatio = white / count;
    const bRatio = black / count;
    const pRatio = parchment / count;
    const aspectRatio = img.width / img.height;

    // cleanup
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = 0;
    canvas.height = 0;
    img = null;

    // HEURISTICS

    // 1. Keep transparent images
    if (tRatio > 0.05) return { action: 'keep' };

    // 2. Solid Images Logic
    // Delete parchment
    if (pRatio > 0.1) return { action: 'delete', reason: `Parchment (${pRatio.toFixed(2)})` };

    // Page-like dimensions (Portrait)
    if (aspectRatio < 0.85) {
        // Only keep if it's very clean white or black background
        if (wRatio > 0.8) return { action: 'keep' }; // Clean white bg
        if (bRatio > 0.8) return { action: 'keep' }; // Clean black bg
        
        return { action: 'delete', reason: `Page-like solid (W:${wRatio.toFixed(2)} B:${bRatio.toFixed(2)})` };
    }

    // Landscape/Square Solid Images
    // Delete low variance (flat color blocks)
    if (stdDev < 15) return { action: 'delete', reason: `Low variance (${stdDev.toFixed(2)})` };

    // Otherwise keep (likely full bleed art or silhouette)
    return { action: 'keep' };
}

async function main() {
    console.log("Loading monsters.json...");
    let monsters = [];
    if (fs.existsSync(MONSTERS_FILE)) {
        monsters = JSON.parse(fs.readFileSync(MONSTERS_FILE, 'utf8'));
    }

    const files = fs.readdirSync(IMAGES_DIR).filter(f => f.endsWith('.png') || f.endsWith('.jpg'));
    console.log(`Scanning ${files.length} images...`);

    let processed = 0;
    let deleted = 0;
    let errors = 0;

    // Process in batches
    const BATCH_SIZE = 20;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        
        await Promise.all(batch.map(async (file) => {
            try {
                const result = await processImage(file);
                if (result.action === 'delete') {
                    // Move file
                    const src = path.join(IMAGES_DIR, file);
                    const dest = path.join(TRASH_DIR, file);
                    if (fs.existsSync(src)) {
                        fs.renameSync(src, dest);
                        deleted++;
                        // console.log(`Deleted ${file}: ${result.reason}`);

                        // Update monsters.json in memory
                        const fileUrl = `http://localhost:5173/images/${file}`;
                        monsters.forEach(m => {
                            if (m.image && m.image.endsWith(file)) {
                                m.image = null;
                            }
                        });
                    }
                } else if (result.action === 'error') {
                    errors++;
                }
            } catch (err) {
                console.log(`Critical error on ${file}: ${err.message}`);
                errors++;
            }
        }));

        processed += batch.length;
        if (processed % 100 === 0) {
            console.log(`Processed ${processed}/${files.length}. Deleted: ${deleted}. Errors: ${errors}.`);
            // Save progress
            fs.writeFileSync(MONSTERS_FILE, JSON.stringify(monsters, null, 2));
            
            // Try to free memory
            if (global.gc) {
                global.gc();
            }
            // Small pause
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }

    // Final save
    fs.writeFileSync(MONSTERS_FILE, JSON.stringify(monsters, null, 2));
    console.log(`Done. Total processed: ${processed}. Total deleted: ${deleted}.`);
}

main();
