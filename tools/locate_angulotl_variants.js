
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function analyzeLayout() {
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

    const targets = [
        'Angulotl Blade',
        'Angulotl Needler',
        'Angulotl Seer',
        'Angulotl Tadpole',
        'Angulotl Slink',
        'Angulotl Yegg'
    ];

    for (let i = 33; i <= 45; i++) {
        const page = await doc.getPage(i);
        const textContent = await page.getTextContent();
        const fullText = textContent.items.map(item => item.str).join(' ');
        
        console.log(`\n--- Page ${i} Analysis ---`);
        
        // Check for targets
        targets.forEach(target => {
            if (fullText.toLowerCase().includes(target.toLowerCase())) {
                console.log(`  FOUND TARGET: "${target}" on Page ${i}`);
            }
        });
    }
}

analyzeLayout().catch(console.error);
