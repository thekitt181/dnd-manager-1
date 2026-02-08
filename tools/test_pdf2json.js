const fs = require('fs');
const path = require('path');
const PDFParser = require("pdf2json");

const pdfParser = new PDFParser();

pdfParser.on("pdfParser_dataError", errData => console.error(errData.parserError));
pdfParser.on("pdfParser_dataReady", pdfData => {
    const page = pdfData.Pages[14]; // Page 15 (0-indexed)
    
    console.log(`Page Width: ${page.Width}, Height: ${page.Height}`);
    
    console.log("\n--- Texts ---");
    page.Texts.slice(0, 10).forEach(t => {
        // x, y, w, sw, A, R (text)
        console.log(`Text: "${decodeURIComponent(t.R[0].T)}" at (${t.x}, ${t.y})`);
    });
    
    console.log("\n--- Fills (might contain images?) ---");
    if (page.Fills) {
        page.Fills.forEach(f => {
            console.log(`Fill at (${f.x}, ${f.y}) with w=${f.w}, h=${f.h}`);
        });
    }
    
    // Check for explicit images if any
    // pdf2json doesn't always expose images directly in the JSON unless configured?
    console.log("\n--- Full Page Keys ---");
    console.log(Object.keys(page));
});

const pdfPath = path.join(__dirname, '../pdfs/monster_manual.pdf');
pdfParser.loadPDF(pdfPath);
