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
    if (!fs.existsSync(filePath)) {
        console.log(`File not found: ${filename}`);
        return null;
    }

    try {
        const img = await Canvas.loadImage(filePath);
        const canvas = Canvas.createCanvas(img.width, img.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        const imageData = ctx.getImageData(0, 0, img.width, img.height);
        const data = imageData.data;
        let r = 0, g = 0, b = 0, a = 0;
        let count = 0;
        let cornerPixels = [];
        
        // Sample corners
        const corners = [
            0, 
            (img.width - 1) * 4, 
            (img.width * (img.height - 1)) * 4, 
            (img.width * img.height - 1) * 4
        ];
        
        // Sample random pixels for average color
        for (let i = 0; i < data.length; i += 40) { // Sample every 10th pixel
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            a += data[i + 3];
            count++;
        }

        const avgR = r / count;
        const avgG = g / count;
        const avgB = b / count;
        const avgA = a / count;

        // Calculate variance/std dev to detect solid colors
        let varR = 0;
        for (let i = 0; i < data.length; i += 40) {
            varR += Math.pow(data[i] - avgR, 2);
        }
        const stdDevR = Math.sqrt(varR / count);

        // Check for "parchment" color (light brownish/beige)
        // R: 200-255, G: 180-240, B: 150-220
        let parchmentCount = 0;
        for (let i = 0; i < data.length; i += 40) {
            if (data[i] > 180 && data[i+1] > 160 && data[i+2] > 140) { // Light color
                // Check if it's not white/gray
                 if (Math.abs(data[i] - data[i+1]) > 10 || Math.abs(data[i] - data[i+2]) > 10) {
                     parchmentCount++;
                 }
            }
        }
        const parchmentRatio = parchmentCount / count;
        
        // Check for transparent background
        let transparentCount = 0;
        let whiteCount = 0;
        let blackCount = 0;
        for (let i = 0; i < data.length; i += 40) {
            if (data[i+3] < 10) transparentCount++;
            else if (data[i] > 240 && data[i+1] > 240 && data[i+2] > 240) whiteCount++;
            else if (data[i] < 15 && data[i+1] < 15 && data[i+2] < 15) blackCount++;
        }
        const transparentRatio = transparentCount / count;
        const whiteRatio = whiteCount / count;
        const blackRatio = blackCount / count;


        return {
            filename,
            width: img.width,
            height: img.height,
            aspectRatio: (img.width / img.height).toFixed(2),
            avgColor: `rgb(${avgR.toFixed(0)}, ${avgG.toFixed(0)}, ${avgB.toFixed(0)})`,
            stdDevR: stdDevR.toFixed(2),
            parchmentRatio: parchmentRatio.toFixed(2),
            transparentRatio: transparentRatio.toFixed(2),
            whiteRatio: whiteRatio.toFixed(2),
            blackRatio: blackRatio.toFixed(2)
        };

    } catch (e) {
        console.log(`Error analyzing ${filename}: ${e.message}`);
        return null;
    }
}

async function main() {
    const files = fs.readdirSync(IMAGES_DIR);
    
    const targets = [
        'marid', 'lucifer', 'ghost', 'aboleth', // Bad candidates
        'aatxe', 'abyssal', 'alp' // Good candidates
    ];

    const matchedFiles = files.filter(f => targets.some(t => f.toLowerCase().includes(t)));

    console.log(`Analyzing ${matchedFiles.length} files...`);
    
    for (const file of matchedFiles) {
        const result = await analyzeImage(file);
        if (result) {
            console.log(JSON.stringify(result));
        }
    }
}

main();
