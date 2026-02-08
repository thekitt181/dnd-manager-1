import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PDFS_DIR = path.join(__dirname, '../pdfs');

async function run() {
    // Get list of PDF files
    const pdfFiles = fs.readdirSync(PDFS_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));
    
    console.log(`Found ${pdfFiles.length} PDFs to process.`);
    
    for (const pdfFile of pdfFiles) {
        console.log(`\n---------------------------------------------------------`);
        console.log(`Starting extraction for: ${pdfFile}`);
        console.log(`---------------------------------------------------------\n`);
        
        await new Promise((resolve, reject) => {
            const child = spawn('node', ['tools/extract_images.js', pdfFile], {
                stdio: 'inherit',
                cwd: path.join(__dirname, '..') // Run from root
            });
            
            child.on('close', (code) => {
                if (code === 0) {
                    console.log(`Successfully processed ${pdfFile}`);
                    resolve();
                } else {
                    console.error(`Process exited with code ${code} for ${pdfFile}`);
                    resolve(); 
                }
            });
            
            child.on('error', (err) => {
                console.error(`Failed to start process for ${pdfFile}:`, err);
                resolve();
            });
        });
        
        // Optional: Small pause to let system settle
        await new Promise(r => setTimeout(r, 1000));
    }
    
    console.log('\nAll PDFs processed.');
}

run().catch(console.error);
