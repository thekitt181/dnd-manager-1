import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const Canvas = require('canvas');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Canvas Factory for Node.js (Minimal)
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
        canvasAndContext.canvas = null;
        canvasAndContext.context = null;
    }
}

async function analyzeLayout(pdfFilename, pageLimit = 5) {
    const pdfPath = path.join(__dirname, '../pdfs', pdfFilename);
    if (!fs.existsSync(pdfPath)) {
        console.error(`PDF not found: ${pdfPath}`);
        return;
    }

    console.log(`Analyzing layout for: ${pdfFilename} (Searching for 'ANGULOTL BLADE')`);
    
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const loadingTask = pdfjsLib.getDocument({
        data,
        cMapUrl: path.join(__dirname, '../node_modules/pdfjs-dist/cmaps/'),
        cMapPacked: true,
        canvasFactory: new NodeCanvasFactory(),
        standardFontDataUrl: path.join(__dirname, '../node_modules/pdfjs-dist/standard_fonts/'),
    });

    const doc = await loadingTask.promise;
    console.log(`Total Pages: ${doc.numPages}`);

    // Dump pages 33-40 to find start of monsters
    for (let i = 33; i <= 40; i++) {
        console.log(`\n--- Page ${i} Content Dump ---`);
        const page = await doc.getPage(i);
        const textContent = await page.getTextContent();
        const text = textContent.items.map(item => item.str).join(' ');
        console.log(text.substring(0, 500));
        
        // Also check headers
        const potentialHeaders = textContent.items
             .filter(item => item.str.trim().length > 0)
             .map(item => ({
                 text: item.str,
                 x: item.transform[4],
                 y: item.transform[5],
                 height: item.transform[3]
             }))
             .filter(item => item.height > 10);
        
        console.log("  Headers > 10px:");
        potentialHeaders.forEach(h => console.log(`    "${h.text}" (H=${h.height.toFixed(1)})`));
    }
    
    return; // Stop here for now

}
// Remove the old loop logic
/*
    const startPage = parseInt(process.argv[3]) || 1;
    const endPage = Math.min(doc.numPages, startPage + pageLimit - 1);
    
    for (let i = startPage; i <= endPage; i++) {
        // ...
    }
*/


const targetPdf = process.argv[2];
if (!targetPdf) {
    console.log("Usage: node tools/analyze_pdf_layout.js <pdf_filename>");
    process.exit(1);
}

analyzeLayout(targetPdf).catch(console.error);
