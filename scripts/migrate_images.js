
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { removeBackground } from './utils/background_remover.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IMAGES_DIR = path.join(__dirname, '../public/images/items');
const ITEMS_PATH = path.join(__dirname, '../src/items.json');

async function migrateImages() {
    console.log("Starting image migration (JPG -> PNG with Background Removal)...");

    if (!fs.existsSync(IMAGES_DIR)) {
        console.log("No images directory found.");
        return;
    }

    const files = fs.readdirSync(IMAGES_DIR);
    const jpgFiles = files.filter(f => f.toLowerCase().endsWith('.jpg'));
    
    console.log(`Found ${jpgFiles.length} JPG images to process.`);
    
    // Load items.json to update references
    let items = [];
    if (fs.existsSync(ITEMS_PATH)) {
        items = JSON.parse(fs.readFileSync(ITEMS_PATH, 'utf-8'));
    }

    let processedCount = 0;
    let errors = 0;

    for (const file of jpgFiles) {
        const jpgPath = path.join(IMAGES_DIR, file);
        const pngFile = file.replace(/\.jpg$/i, '.png');
        const pngPath = path.join(IMAGES_DIR, pngFile);
        
        console.log(`[${processedCount + 1}/${jpgFiles.length}] Processing ${file}...`);

        try {
            const buffer = fs.readFileSync(jpgPath);
            const pngBuffer = await removeBackground(buffer);
            
            fs.writeFileSync(pngPath, pngBuffer);
            
            // Delete old JPG
            fs.unlinkSync(jpgPath);

            // Update items.json reference
            const oldRef = `/images/items/${file}`;
            const newRef = `/images/items/${pngFile}`;
            
            let updated = false;
            for (const item of items) {
                if (item.image === oldRef) {
                    item.image = newRef;
                    updated = true;
                }
            }

            processedCount++;
        } catch (e) {
            console.error(`Failed to process ${file}:`, e);
            errors++;
        }
    }

    // Save updated items.json
    if (processedCount > 0) {
        fs.writeFileSync(ITEMS_PATH, JSON.stringify(items, null, 2));
        console.log("Updated items.json with new image paths.");
    }

    console.log(`Migration complete. Processed: ${processedCount}, Errors: ${errors}`);
}

migrateImages().catch(console.error);
