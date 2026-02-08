
import { createCanvas, loadImage } from 'canvas';

export async function removeBackground(imageBuffer) {
    const img = await loadImage(imageBuffer);
    const width = img.width;
    const height = img.height;
    
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
    
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const w = width;
    const h = height;

    // --- Background Removal Logic (Ported from popover.js) ---
    let edgePixels = [];
    const addEdgeSample = (x, y) => {
        const idx = (y * w + x) * 4;
        edgePixels.push({
            r: data[idx], g: data[idx+1], b: data[idx+2], a: data[idx+3],
            idx: idx
        });
    };

    // Sample Top & Bottom rows
    for (let x = 0; x < w; x++) { addEdgeSample(x, 0); addEdgeSample(x, h-1); }
    // Sample Left & Right columns
    for (let y = 1; y < h-1; y++) { addEdgeSample(0, y); addEdgeSample(w-1, y); }

    let whiteCount = 0;
    let blackCount = 0;
    let transparentCount = 0;
    let avgR = 0, avgG = 0, avgB = 0;
    let totalSamples = edgePixels.length;

    for (const p of edgePixels) {
        if (p.a < 50) {
            transparentCount++;
            continue;
        }
        // Relaxed threshold for white - expanded range for generated images
        if (p.r > 180 && p.g > 180 && p.b > 180) {
            whiteCount++;
            avgR += p.r; avgG += p.g; avgB += p.b;
        } else if (p.r < 80 && p.g < 80 && p.b < 80) { // Expanded black range
            blackCount++;
        }
    }

    let targetMode = null;
    // Lower threshold to 25% to catch partial backgrounds
    const whiteThreshold = totalSamples * 0.25;
    const blackThreshold = totalSamples * 0.25;

    if (transparentCount > totalSamples * 0.9) {
        // Already transparent
        return canvas.toBuffer('image/png');
    } else if (whiteCount > whiteThreshold) {
        targetMode = 'white';
        avgR = Math.round(avgR / whiteCount);
        avgG = Math.round(avgG / whiteCount);
        avgB = Math.round(avgB / whiteCount);
    } else if (blackCount > blackThreshold) {
        targetMode = 'black';
        avgR = 0; avgG = 0; avgB = 0;
    }

    if (targetMode) {
        // console.log(`Detected ${targetMode} background. AvgColor: ${avgR},${avgG},${avgB}. Removing...`);
        
        // Increased tolerance for generated images
        const tolerance = 90;
        const queue = [];
        const visited = new Uint8Array(w * h);
        
        const checkAndSeed = (x, y) => {
            const idx = y * w + x;
            if (visited[idx]) return;

            const i = idx * 4;
            const r = data[i];
            const g = data[i+1];
            const b = data[i+2];
            const a = data[i+3];

            if (a < 50) return;

            const dist = Math.abs(r - avgR) + Math.abs(g - avgG) + Math.abs(b - avgB);
            
            if (dist < tolerance * 1.5) {
                queue.push(idx);
                visited[idx] = 1;
            }
        };

        for (let x = 0; x < w; x++) { checkAndSeed(x, 0); checkAndSeed(x, h-1); }
        for (let y = 1; y < h-1; y++) { checkAndSeed(0, y); checkAndSeed(w-1, y); }

        while (queue.length > 0) {
            const idx = queue.shift();
            const x = idx % w;
            const y = Math.floor(idx / w);
            const i = idx * 4;

            data[i+3] = 0; // Make transparent

            const neighbors = [
                {nx: x+1, ny: y}, {nx: x-1, ny: y},
                {nx: x, ny: y+1}, {nx: x, ny: y-1}
            ];

            for (const {nx, ny} of neighbors) {
                if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                    const nIdx = ny * w + nx;
                    if (!visited[nIdx]) {
                        const ni = nIdx * 4;
                        const nr = data[ni];
                        const ng = data[ni+1];
                        const nb = data[ni+2];
                        
                        const dist = Math.abs(nr - avgR) + Math.abs(ng - avgG) + Math.abs(nb - avgB);
                        
                        if (dist < tolerance * 3) {
                            visited[nIdx] = 1;
                            queue.push(nIdx);
                        }
                    }
                }
            }
        }
        ctx.putImageData(imageData, 0, 0);
    }
    
    return canvas.toBuffer('image/png');
}
