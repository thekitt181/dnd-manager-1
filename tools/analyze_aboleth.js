import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Canvas = require('canvas');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = path.join(__dirname, '../public/images');

async function analyzeImage(filename) {
    const filePath = path.join(IMAGES_DIR, filename);
    if (!fs.existsSync(filePath)) return null;

    try {
        const img = await Canvas.loadImage(filePath);
        const canvas = Canvas.createCanvas(img.width, img.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        const imageData = ctx.getImageData(0, 0, img.width, img.height);
        const data = imageData.data;
        let r = 0, g = 0, b = 0, a = 0;
        let count = 0;
        let parchment = 0;
        let white = 0;
        let black = 0;
        let transparent = 0;

        for (let i = 0; i < data.length; i += 40) {
            const dr = data[i];
            const dg = data[i+1];
            const db = data[i+2];
            const da = data[i+3];

            r += dr; g += dg; b += db;
            a += da;
            count++;

            if (da < 10) transparent++;
            else {
                if (dr > 230 && dg > 230 && db > 230) white++;
                else if (dr < 25 && dg < 25 && db < 25) black++;
                
                // Parchment detection (beige/tan)
                // Relaxed threshold for parchment
                if (dr > 160 && dg > 140 && db > 110 && dr > db + 10) parchment++;
            }
        }

        const avgR = r / count;
        const avgG = g / count;
        const avgB = b / count;

        let varSum = 0;
        for (let i = 0; i < data.length; i += 40) {
            varSum += Math.pow(data[i] - avgR, 2);
        }
        const stdDev = Math.sqrt(varSum / count);

        return {
            filename,
            width: img.width,
            height: img.height,
            aspectRatio: (img.width / img.height).toFixed(2),
            avgColor: `rgb(${avgR.toFixed(0)}, ${avgG.toFixed(0)}, ${avgB.toFixed(0)})`,
            stdDev: stdDev.toFixed(2),
            parchmentRatio: (parchment / count).toFixed(2),
            transparentRatio: (transparent / count).toFixed(2),
            whiteRatio: (white / count).toFixed(2),
            blackRatio: (black / count).toFixed(2)
        };

    } catch (e) {
        return null;
    }
}

async function main() {
    const files = fs.readdirSync(IMAGES_DIR);
    const targets = files.filter(f => f.includes('abominable'));
    
    console.log(`Analyzing ${targets.length} files...`);
    
    for (const file of targets) {
        const result = await analyzeImage(file);
        if (result) {
            console.log(JSON.stringify(result));
        }
    }
}

main();
