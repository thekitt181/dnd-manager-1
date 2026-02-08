
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function dumpPageText() {
    const pdfPath = path.join(__dirname, '../pdfs/Flee__Mortals__The_MCDM_Monster_Book_v1.0.pdf');
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    
    const loadingTask = pdfjsLib.getDocument({
        data,
        cMapUrl: path.join(__dirname, '../node_modules/pdfjs-dist/cmaps/'),
        cMapPacked: true,
        standardFontDataUrl: path.join(__dirname, '../node_modules/pdfjs-dist/standard_fonts/'),
    });

    const doc = await loadingTask.promise;
    console.log(`Loaded PDF: ${doc.numPages} pages`);

    const pageNum = 56;
    const page = await doc.getPage(pageNum);
    const textContent = await page.getTextContent();
    
    console.log(`\n--- Page ${pageNum} Text Dump ---`);
    textContent.items.forEach(item => {
        // y is 0 at bottom in PDF, but we usually think top-down. 
        // pdf.js gives [scaleX, skewY, skewX, scaleY, x, y]
        // y coordinate is item.transform[5]
        console.log(`Text: "${item.str}" | Y: ${item.transform[5].toFixed(2)} | H: ${item.height}`);
    });
}

dumpPageText().catch(console.error);
