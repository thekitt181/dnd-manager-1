
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const fs = require('fs');

async function findMonsterPage() {
    const pdfPath = 'pdfs/Flee__Mortals__The_MCDM_Monster_Book_v1.0.pdf';
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjsLib.getDocument(data).promise;
    
    console.log(`Searching ${doc.numPages} pages for "Pitling"...`);

    for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const textItems = content.items;
        const text = textItems.map(item => item.str).join(' ');
        
        if (text.toLowerCase().includes('pitling')) {
            console.log(`Found "Pitling" on page ${i}`);
            // Find specific item coordinates
            const items = textItems.filter(item => item.str.toLowerCase().includes('pitling'));
            items.forEach(item => {
                console.log(`  Position: x=${item.transform[4]}, y=${item.transform[5]}, text="${item.str}"`);
            });
        }
    }
}

findMonsterPage();
