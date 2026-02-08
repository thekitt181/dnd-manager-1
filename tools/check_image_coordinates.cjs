
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const fs = require('fs');

async function checkImageCoords() {
    const pdfPath = 'pdfs/Flee__Mortals__The_MCDM_Monster_Book_v1.0.pdf';
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjsLib.getDocument(data).promise;
    
    const pageNum = 64;
    console.log(`Checking image coordinates on page ${pageNum}...`);

    const page = await doc.getPage(pageNum);
    const ops = await page.getOperatorList();
    
    let imageCount = 0;
    
    // Track current transform matrix
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
            const [a, b, c, d, e, f] = args;
            // Multiply currentMatrix * newMatrix
            const [a1, b1, c1, d1, e1, f1] = currentMatrix;
            currentMatrix = [
                a1 * a + c1 * b,
                b1 * a + d1 * b,
                a1 * c + c1 * d,
                b1 * c + d1 * d,
                a1 * e + c1 * f + e1,
                b1 * e + d1 * f + f1
            ];
        } else if (fn === pdfjsLib.OPS.paintImageXObject || fn === pdfjsLib.OPS.paintInlineImageXObject) {
            const imgName = args[0];
            const width = Math.hypot(currentMatrix[0], currentMatrix[1]);
            const height = Math.hypot(currentMatrix[2], currentMatrix[3]);
            const x = currentMatrix[4];
            const y = currentMatrix[5];
            
            console.log(`Image ${imageCount++}: ${imgName}`);
            console.log(`  Position: x=${x.toFixed(2)}, y=${y.toFixed(2)}`);
            console.log(`  Size: w=${width.toFixed(2)}, h=${height.toFixed(2)}`);
        }
    }
}

checkImageCoords();
