
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const Canvas = require('canvas');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBUG_DIR = path.join(__dirname, '../debug_output');

if (!fs.existsSync(DEBUG_DIR)) {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

// Canvas Factory for Node.js
class NodeCanvasFactory {
    create(width, height) {
        const canvas = Canvas.createCanvas(width, height);
        const context = canvas.getContext('2d');
        return { canvas, context };
    }

    reset(canvasAndContext, width, height) {
        canvasAndContext.canvas.width = width;
        canvasAndContext.canvas.height = height;
    }

    destroy(canvasAndContext) {
        canvasAndContext.canvas.width = 0;
        canvasAndContext.canvas.height = 0;
        canvasAndContext.canvas = null;
        canvasAndContext.context = null;
    }
}

function analyzeImageComplexity(imgData) {
    const data = imgData.data;
    const isRGBA = data.length === imgData.width * imgData.height * 4;
    const stride = isRGBA ? 4 : 3;

    const colorSet = new Set();
    let sumR = 0, sumG = 0, sumB = 0;
    let sumSqR = 0, sumSqG = 0, sumSqB = 0;
    let pixelCount = 0;
    let blackPixelCount = 0;
    let transparentCount = 0;

    for (let i = 0; i < data.length; i += stride) {
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];
        const a = isRGBA ? data[i+3] : 255;

        if (a < 50) {
            transparentCount++;
            continue; 
        }

        pixelCount++;
        sumR += r;
        sumG += g;
        sumB += b;
        sumSqR += r*r;
        sumSqG += g*g;
        sumSqB += b*b;

        // Quantize color for unique count (reduced precision)
        const key = `${Math.floor(r/16)},${Math.floor(g/16)},${Math.floor(b/16)}`;
        colorSet.add(key);

        if (r < 40 && g < 40 && b < 40) blackPixelCount++;
    }

    if (pixelCount === 0) return { uniqueColors: 0, stdDev: 0, blackRatio: 0, pixelCount: 0 };

    const avgR = sumR / pixelCount;
    const avgG = sumG / pixelCount;
    const avgB = sumB / pixelCount;

    const varR = (sumSqR / pixelCount) - (avgR * avgR);
    const varG = (sumSqG / pixelCount) - (avgG * avgG);
    const varB = (sumSqB / pixelCount) - (avgB * avgB);

    const stdDev = Math.sqrt(Math.abs(varR + varG + varB)); 
    const blackRatio = blackPixelCount / pixelCount;

    return { uniqueColors: colorSet.size, stdDev, blackRatio, avgR, avgG, avgB, pixelCount, transparentCount };
}

async function debugPage(pdfPath, pageNum) {
    console.log(`Processing ${path.basename(pdfPath)} Page ${pageNum}`);
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const loadingTask = pdfjsLib.getDocument({
        data,
        cMapUrl: path.join(__dirname, '../node_modules/pdfjs-dist/cmaps/'),
        cMapPacked: true,
        canvasFactory: new NodeCanvasFactory(),
        standardFontDataUrl: path.join(__dirname, '../node_modules/pdfjs-dist/standard_fonts/'),
    });

    const doc = await loadingTask.promise;
    const page = await doc.getPage(pageNum);
    
    // 1. Dump Text
    const textContent = await page.getTextContent();
    console.log('\n--- Text Content ---');
    textContent.items.forEach(item => {
        if (item.str.trim().length > 0) {
            console.log(`Text: "${item.str}" | Y: ${item.transform[5].toFixed(2)} | H: ${item.height.toFixed(2)}`);
        }
    });

    // 2. Extract Images
    const ops = await page.getOperatorList();
    console.log('\n--- Images ---');
    
    let imgIndex = 0;
    for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] === pdfjsLib.OPS.paintImageXObject) {
            const imgName = ops.argsArray[i][0];
            console.log(`\nImage Found: ${imgName}`);
            
            try {
                let img = await new Promise((resolve) => {
                    page.objs.get(imgName, (obj) => {
                        resolve(obj);
                    });
                });

                if (!img) {
                    img = await new Promise((resolve) => {
                        page.commonObjs.get(imgName, (obj) => {
                            resolve(obj);
                        });
                    });
                }
                
                if (!img) {
                    console.log('  Could not retrieve image object.');
                    continue;
                }

                const width = img.width;
                const height = img.height;
                console.log(`  Dimensions: ${width}x${height}`);
                
                // Skip small icons
                if (width < 50 || height < 50) {
                    console.log('  Skipping: Too small');
                    continue;
                }

                const canvas = Canvas.createCanvas(width, height);
                const ctx = canvas.getContext('2d');
                
                // Draw image to canvas
                const imgData = ctx.createImageData(width, height);
                
                if (img.kind === pdfjsLib.ImageKind.RGBA_32BPP) {
                    imgData.data.set(img.data);
                } else if (img.kind === pdfjsLib.ImageKind.RGB_24BPP) {
                    let j = 0;
                    for (let k = 0; k < img.data.length; k += 3) {
                        imgData.data[j++] = img.data[k];
                        imgData.data[j++] = img.data[k + 1];
                        imgData.data[j++] = img.data[k + 2];
                        imgData.data[j++] = 255;
                    }
                } else if (img.kind === pdfjsLib.ImageKind.GRAYSCALE_1BPP) {
                     // Handle 1BPP (masks often come as 1BPP)
                     // This is simplified; usually needs decoding
                     console.log('  Format: GRAYSCALE_1BPP (Mask?)');
                     // We might need to invert or treat as mask
                } else {
                    console.log(`  Format: ${img.kind} (handling might be limited)`);
                }

                ctx.putImageData(imgData, 0, 0);

                // Analyze
                const complexity = analyzeImageComplexity(imgData);
                console.log('  Complexity Analysis:', JSON.stringify(complexity, null, 2));

                const filename = `page_${pageNum}_img_${imgIndex}_${width}x${height}.png`;
                const outPath = path.join(DEBUG_DIR, filename);
                
                const outStream = fs.createWriteStream(outPath);
                const stream = canvas.createPNGStream();
                stream.pipe(outStream);
                
                console.log(`  Saved to: ${filename}`);
                imgIndex++;

            } catch (err) {
                console.error('  Error extracting image:', err.message);
            }
        }
    }
}

const pdfPath = process.argv[2];
const pageNum = parseInt(process.argv[3]);

if (!pdfPath || isNaN(pageNum)) {
    console.error('Usage: node extract_page_images_debug.js <pdf_path> <page_num>');
    process.exit(1);
}

debugPage(pdfPath, pageNum).catch(console.error);
