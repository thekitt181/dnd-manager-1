
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const Canvas = require('canvas');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function isWhiteSilhouette(imgData, log = false) {
    let foregroundCount = 0;
    let sumR = 0, sumG = 0, sumB = 0;
    let sumDiff = 0;

    const data = imgData.data;
    const isRGBA = data.length === imgData.width * imgData.height * 4;
    const stride = isRGBA ? 4 : 3;

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

    if (foregroundCount < 50) {
        if (log) console.log(`      Too small (foreground pixels: ${foregroundCount})`);
        return false; 
    }

    const avgR = sumR / foregroundCount;
    const avgG = sumG / foregroundCount;
    const avgB = sumB / foregroundCount;
    const avgDiff = sumDiff / foregroundCount;

    if (log) console.log(`      Stats: R=${avgR.toFixed(1)}, G=${avgG.toFixed(1)}, B=${avgB.toFixed(1)}, Diff=${avgDiff.toFixed(1)}`);

    if (avgR > 210 && avgG > 210 && avgB > 210 && avgDiff < 20) {
        if (log) console.log(`      -> IS WHITE SILHOUETTE`);
        return true;
    }
    return false;
}

async function debugPage(pdfPath, pageNum) {
    console.log(`Loading PDF: ${pdfPath}`);
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const loadingTask = pdfjsLib.getDocument({
        data,
        cMapUrl: path.join(__dirname, '../node_modules/pdfjs-dist/cmaps/'),
        cMapPacked: true,
        canvasFactory: new NodeCanvasFactory(),
        standardFontDataUrl: path.join(__dirname, '../node_modules/pdfjs-dist/standard_fonts/'),
    });

    const doc = await loadingTask.promise;
    console.log(`Loaded. Getting page ${pageNum}...`);
    const page = await doc.getPage(pageNum);
    
    const ops = await page.getOperatorList();
    if (!ops || !ops.fnArray) {
        console.error("No operators found or invalid structure.");
        return;
    }
    console.log(`Got ${ops.fnArray.length} ops.`);

    let imgCount = 0;
    const validObjectTypes = [
        pdfjsLib.OPS.paintImageXObject,
        pdfjsLib.OPS.paintXObject,
        pdfjsLib.OPS.paintInlineImageXObject
    ];

    for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i];

        if (validObjectTypes.includes(fn)) {
            imgCount++;
            const imgName = args[0];
            console.log(`\nImage #${imgCount} (Name: ${imgName})`);
            
            try {
                await new Promise((resolve) => {
                    page.objs.get(imgName, (imgObj) => {
                        if (!imgObj) {
                            console.log("  Could not retrieve image object.");
                            resolve();
                            return;
                        }

                        console.log(`  Size: ${imgObj.width}x${imgObj.height}`);
                        if (imgObj.data) {
                             console.log(`  Kind: ${imgObj.kind}, Data Length: ${imgObj.data.length}`);
                             
                             const width = imgObj.width;
                             const height = imgObj.height;
                             const canvasFactory = new NodeCanvasFactory();
                             const { canvas, context } = canvasFactory.create(width, height);
                             const imgData = context.createImageData(width, height);

                             if (imgObj.data.length === width * height * 4) {
                                 imgData.data.set(imgObj.data);
                             } else if (imgObj.data.length === width * height * 3) {
                                 for (let j = 0, k = 0; j < imgObj.data.length; j += 3, k += 4) {
                                     imgData.data[k] = imgObj.data[j];
                                     imgData.data[k+1] = imgObj.data[j+1];
                                     imgData.data[k+2] = imgObj.data[j+2];
                                     imgData.data[k+3] = 255;
                                 }
                             } else {
                                 console.log("  Unknown format/mask, skipping pixel check.");
                             }
                             
                             if (imgData) {
                                 isWhiteSilhouette(imgData, true);
                             }
                        }
                        resolve();
                    });
                });
                
            } catch (err) {
                console.error("  Error processing image:", err);
            }
        }
    }
}

const pdfPath = process.argv[2];
const pageNum = parseInt(process.argv[3]);
debugPage(pdfPath, pageNum).catch(console.error);
