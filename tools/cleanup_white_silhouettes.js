import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Canvas = require('canvas');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = path.join(__dirname, '../public/images');
const MONSTERS_FILE = path.join(__dirname, '../src/monsters.json');

// Copy of the updated isWhiteSilhouette function from extract_images.js
function isWhiteSilhouette(img, context) {
    const width = img.width;
    const height = img.height;
    
    // Draw to canvas to get data
    const canvas = Canvas.createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;
    const isRGBA = data.length === width * height * 4;
    const stride = isRGBA ? 4 : 3;

    let foregroundCount = 0;
    let sumR = 0, sumG = 0, sumB = 0;
    let sumDiff = 0;

    for (let i = 0; i < data.length; i += stride) {
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];
        const a = isRGBA ? data[i+3] : 255;

        // Skip transparent or black background
        if (a < 50 || (r < 40 && g < 40 && b < 40)) continue;

        foregroundCount++;
        sumR += r;
        sumG += g;
        sumB += b;
        
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        sumDiff += (max - min);
    }

    if (foregroundCount < 50) return false;

    const avgR = sumR / foregroundCount;
    const avgG = sumG / foregroundCount;
    const avgB = sumB / foregroundCount;
    const avgDiff = sumDiff / foregroundCount;

    // Strict threshold: Bright (>210) AND Low Saturation (<20)
    if (avgR > 210 && avgG > 210 && avgB > 210 && avgDiff < 20) {
        return { isWhite: true, stats: { r: avgR, g: avgG, b: avgB, diff: avgDiff } };
    }
    return { isWhite: false, stats: { r: avgR, g: avgG, b: avgB, diff: avgDiff } };
}

async function cleanup() {
    if (!fs.existsSync(MONSTERS_FILE)) {
        console.error('Monsters file not found!');
        return;
    }

    const monsters = JSON.parse(fs.readFileSync(MONSTERS_FILE, 'utf8'));
    let removedCount = 0;

    // Scan directories
    const pdfDirs = fs.readdirSync(IMAGES_DIR).filter(f => fs.statSync(path.join(IMAGES_DIR, f)).isDirectory());
    
    for (const dir of pdfDirs) {
        const dirPath = path.join(IMAGES_DIR, dir);
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.png') || f.endsWith('.jpg'));
        
        console.log(`Scanning ${dir} (${files.length} images)...`);
        
        for (const file of files) {
            const filePath = path.join(dirPath, file);
            
            try {
                const img = await Canvas.loadImage(filePath);
                const result = isWhiteSilhouette(img);
                
                if (result.isWhite) {
                    console.log(`[DELETE] White Silhouette: ${file} (R:${result.stats.r.toFixed(0)} G:${result.stats.g.toFixed(0)} B:${result.stats.b.toFixed(0)} Diff:${result.stats.diff.toFixed(0)})`);
                    
                    // Delete file
                    fs.unlinkSync(filePath);
                    
                    // Update monsters
                    const imageUrl = `http://localhost:5173/images/${dir}/${file}`;
                    let monsterUpdated = false;
                    
                    monsters.forEach(m => {
                        if (m.image === imageUrl) {
                            console.log(`  -> Removing image from monster: ${m.name}`);
                            m.image = null;
                            monsterUpdated = true;
                            removedCount++;
                        }
                    });
                    
                    if (!monsterUpdated) {
                        console.log(`  -> No monster linked to this image.`);
                    }
                }
            } catch (err) {
                console.error(`Error processing ${file}:`, err.message);
            }
        }
    }

    if (removedCount > 0) {
        fs.writeFileSync(MONSTERS_FILE, JSON.stringify(monsters, null, 2));
        console.log(`\nUpdated monsters.json. Removed ${removedCount} image assignments.`);
    } else {
        console.log('\nNo changes made to monsters.json.');
    }
}

cleanup();
