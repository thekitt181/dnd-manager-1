import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configure worker
// For Node.js with legacy build, we don't need workerSrc usually if we use disableWorker=true or standard loading?
// Actually, pdfjs-dist in Node uses a fake worker by default.
// Let's explicitly try to NOT set workerSrc and let it fallback, or point to the legacy worker.

// Attempt to use canvas factory for image support
class NodeCanvasFactory {
  create(width, height) {
    const Canvas = require('canvas');
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

async function extractPage(pdfPath, pageNum) {
    const data = new Uint8Array(require('fs').readFileSync(pdfPath));
    
    const loadingTask = pdfjsLib.getDocument({ 
        data,
        cMapUrl: path.join(__dirname, '../node_modules/pdfjs-dist/cmaps/'),
        cMapPacked: true,
        canvasFactory: new NodeCanvasFactory(), // Critical for image decoding in Node
        standardFontDataUrl: path.join(__dirname, '../node_modules/pdfjs-dist/standard_fonts/'), // Ensure fonts are found
    });
    
    const doc = await loadingTask.promise;
    console.log(`Loaded PDF with ${doc.numPages} pages.`);
    
    // Check pages around 14
    // for (let p = 13; p <= 17; p++) { ... }

    const page = await doc.getPage(pageNum);
    
    // Get Text
    const textContent = await page.getTextContent();
    // console.log(`\n--- Page ${pageNum} Text Sample ---`);
    // textContent.items.slice(0, 5).forEach(item => {
    //     console.log(`Text: "${item.str}" at Y=${item.transform[5]}`);
    // });

    console.log(`--- Page ${pageNum} All Text ---`);
    console.log(textContent.items.map(t => t.str).join(' '));
    
    // Get Operator List
    const ops = await page.getOperatorList();
    
    const validObjectTypes = [
        pdfjsLib.OPS.paintImageXObject,
        pdfjsLib.OPS.paintXObject,
        pdfjsLib.OPS.paintInlineImageXObject
    ];

    let imageCount = 0;

    let currentMatrix = [1, 0, 0, 1, 0, 0];
    const transformStack = [];

    for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i];

        if (fn === pdfjsLib.OPS.save) {
            transformStack.push([...currentMatrix]);
        } else if (fn === pdfjsLib.OPS.restore) {
            if (transformStack.length > 0) {
                currentMatrix = transformStack.pop();
            }
        } else if (fn === pdfjsLib.OPS.transform) {
            // args is [a, b, c, d, e, f]
            // Multiply currentMatrix * args
            // Simplified: just update translate for now or replace?
            // Transform matrix multiplication is:
            // [a c e]
            // [b d f]
            // [0 0 1]
            // We are interested in e (x) and f (y)
            // But usually for images, the transform sets the position and scale directly if it's right before.
            // Let's just store the last transform args for simplicity of debugging.
            currentMatrix = args; 
        }

        if (validObjectTypes.includes(fn)) {
            const imageName = args[0];
            console.log(`Found Image Operation: ${fn} with name ${imageName}`);
            console.log(`  Transform Matrix: [${currentMatrix.join(', ')}]`);
            console.log(`  Approx Y: ${currentMatrix[5]}, Height (scale Y): ${currentMatrix[3]}`);
            
            try {
                // To get actual image data, we must retrieve it from page.objs
                page.objs.get(imageName, (imgData) => {
                    imageCount++;
                    if (imgData) {
                        console.log(`  Image Data found! Kind: ${imgData.kind}, Width: ${imgData.width}, Height: ${imgData.height}`);
                        
                        if (imgData.width > 200 && imgData.height > 200) {
                             const Canvas = require('canvas');
                             const canvas = Canvas.createCanvas(imgData.width, imgData.height);
                             const ctx = canvas.getContext('2d');
                             
                             // Create ImageData
                             // imgData.data is a Uint8ClampedArray (RGBA) usually
                             const imageData = ctx.createImageData(imgData.width, imgData.height);
                             
                             if (imgData.data.length === imgData.width * imgData.height * 4) {
                                 imageData.data.set(imgData.data);
                             } else if (imgData.data.length === imgData.width * imgData.height * 3) {
                                 // Convert RGB to RGBA
                                 for (let j = 0, k = 0; j < imgData.data.length; j += 3, k += 4) {
                                     imageData.data[k] = imgData.data[j];
                                     imageData.data[k + 1] = imgData.data[j + 1];
                                     imageData.data[k + 2] = imgData.data[j + 2];
                                     imageData.data[k + 3] = 255;
                                 }
                             } else {
                                 console.log(`    Warning: Data length ${imgData.data.length} does not match dimensions ${imgData.width}x${imgData.height}`);
                                 return;
                             }
                             
                             ctx.putImageData(imageData, 0, 0);
                             const buffer = canvas.toBuffer('image/png');
                             const outPath = path.join(__dirname, `debug_image_${imageName}.png`);
                             require('fs').writeFileSync(outPath, buffer);
                             console.log(`    Saved to ${outPath}`);
                        }
                    }
                });
            } catch (e) {
                console.log("  Error retrieving image data:", e.message);
            }
        }
    }
    
    console.log(`\nFound ${imageCount} potential images on page ${pageNum}`);
}

const pdfPath = path.join(__dirname, '../pdfs/Creature_Codex.pdf');
extractPage(pdfPath, 16).catch(err => console.error("Fatal Error:", err));

