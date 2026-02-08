
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Canvas = require('canvas');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = path.join(__dirname, '../public/images');
const MONSTERS_FILE = path.join(__dirname, '../src/monsters.json');

const INPUT_FILE = path.join(IMAGES_DIR, 'acid_ant.jpg');
const OUTPUT_FILE = path.join(IMAGES_DIR, 'acid_ant_cropped.png');

async function cropImage() {
    console.log(`Loading ${INPUT_FILE}...`);
    if (!fs.existsSync(INPUT_FILE)) {
        console.error("Input file not found!");
        return;
    }

    const img = await Canvas.loadImage(INPUT_FILE);
    const width = img.width;
    const height = img.height;
    
    console.log(`Image dimensions: ${width}x${height}`);

    const canvas = Canvas.createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    // Smart Background Removal (Flood Fill from Corners)
    // 1. Sample corners
    const corners = [
        { x: 0, y: 0 },
        { x: width - 1, y: 0 },
        { x: 0, y: height - 1 },
        { x: width - 1, y: height - 1 }
    ];

    const visited = new Uint8Array(width * height); // 0 = unvisited, 1 = visited
    const queue = [];

    // Threshold for color difference (0-255)
    // Green screen backgrounds can vary, so we need a decent tolerance.
    const THRESHOLD = 40; 

    // Helper to get color at x,y
    function getColor(x, y) {
        const idx = (y * width + x) * 4;
        return {
            r: data[idx],
            g: data[idx + 1],
            b: data[idx + 2],
            a: data[idx + 3]
        };
    }

    // Helper to check difference
    function isSimilar(c1, c2) {
        return Math.abs(c1.r - c2.r) < THRESHOLD &&
               Math.abs(c1.g - c2.g) < THRESHOLD &&
               Math.abs(c1.b - c2.b) < THRESHOLD;
    }

    // Initialize queue with corners that match the top-left color (assuming uniform background)
    // Actually, just start with (0,0) and see if other corners match it.
    const startColor = getColor(0, 0);
    console.log(`Background Color detected: R=${startColor.r}, G=${startColor.g}, B=${startColor.b}`);

    // Check all corners, if they are similar, add to queue
    corners.forEach(p => {
        const c = getColor(p.x, p.y);
        if (isSimilar(startColor, c)) {
            queue.push(p);
            visited[p.y * width + p.x] = 1;
        }
    });

    // BFS Flood Fill to remove background
    let removedCount = 0;

    while (queue.length > 0) {
        const { x, y } = queue.shift();
        const idx = (y * width + x) * 4;

        // Make transparent
        data[idx + 3] = 0;
        removedCount++;

        // Neighbors (4-way)
        const neighbors = [
            { x: x + 1, y: y },
            { x: x - 1, y: y },
            { x: x, y: y + 1 },
            { x: x, y: y - 1 }
        ];

        for (const n of neighbors) {
            if (n.x >= 0 && n.x < width && n.y >= 0 && n.y < height) {
                const vIdx = n.y * width + n.x;
                if (visited[vIdx] === 0) {
                    const nColor = getColor(n.x, n.y);
                    if (isSimilar(startColor, nColor)) {
                        visited[vIdx] = 1;
                        queue.push(n);
                    }
                }
            }
        }
    }

    console.log(`Removed ${removedCount} pixels (${Math.round(removedCount / (width * height) * 100)}%)`);

    ctx.putImageData(imageData, 0, 0);

    // Crop Transparent Borders
    // Find bounds of non-transparent pixels
    let minX = width, minY = height, maxX = 0, maxY = 0;
    let foundContent = false;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            if (data[idx + 3] > 0) { // Not transparent
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                foundContent = true;
            }
        }
    }

    if (foundContent) {
        const cropWidth = maxX - minX + 1;
        const cropHeight = maxY - minY + 1;
        console.log(`Cropping to: ${cropWidth}x${cropHeight} at (${minX},${minY})`);

        const croppedCanvas = Canvas.createCanvas(cropWidth, cropHeight);
        const croppedCtx = croppedCanvas.getContext('2d');
        croppedCtx.drawImage(canvas, minX, minY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
        
        const buffer = croppedCanvas.toBuffer('image/png');
        fs.writeFileSync(OUTPUT_FILE, buffer);
        console.log(`Saved to ${OUTPUT_FILE}`);
    } else {
        console.warn("Image was completely erased! Saving original as PNG.");
        const buffer = canvas.toBuffer('image/png');
        fs.writeFileSync(OUTPUT_FILE, buffer);
    }

    // Update monsters.json
    const monsters = JSON.parse(fs.readFileSync(MONSTERS_FILE, 'utf8'));
    let updated = false;
    for (const m of monsters) {
        if (m.name === 'ACID ANT') {
            m.image = 'http://localhost:5173/images/acid_ant_cropped.png';
            updated = true;
            console.log("Updated monsters.json for ACID ANT");
        }
    }

    if (updated) {
        fs.writeFileSync(MONSTERS_FILE, JSON.stringify(monsters, null, 2));
    }
}

cropImage().catch(console.error);
