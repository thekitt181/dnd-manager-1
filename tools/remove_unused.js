import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONSTERS_FILE = path.join(__dirname, '../src/monsters.json');
const IMAGES_DIR = path.join(__dirname, '../public/images');
const TRASH_DIR = path.join(__dirname, '../public/images_trash');

if (!fs.existsSync(TRASH_DIR)) {
    fs.mkdirSync(TRASH_DIR, { recursive: true });
}

function main() {
    console.log('Loading monsters.json...');
    const monsters = JSON.parse(fs.readFileSync(MONSTERS_FILE, 'utf-8'));

    // 1. Collect used filenames
    const usedImages = new Set();
    monsters.forEach(m => {
        if (m.image) {
            // Extract filename from URL: http://localhost:5173/images/filename.png
            const parts = m.image.split('/');
            const filename = parts[parts.length - 1];
            usedImages.add(filename);
        }
    });

    console.log(`Found ${usedImages.size} used images in monsters.json.`);

    // 2. Scan directory
    if (!fs.existsSync(IMAGES_DIR)) {
        console.log('Images directory not found.');
        return;
    }

    const files = fs.readdirSync(IMAGES_DIR);
    console.log(`Found ${files.length} files in images directory.`);

    // 3. Identify and remove unused
    let removedCount = 0;
    files.forEach(file => {
        if (!usedImages.has(file)) {
            const src = path.join(IMAGES_DIR, file);
            const dest = path.join(TRASH_DIR, file);
            
            // Move to trash
            try {
                fs.renameSync(src, dest);
                removedCount++;
                // console.log(`Removed unused: ${file}`);
            } catch (e) {
                console.error(`Failed to remove ${file}: ${e.message}`);
            }
        }
    });

    console.log(`Cleanup complete.`);
    console.log(`Total files in dir: ${files.length}`);
    console.log(`Used images: ${usedImages.size}`);
    console.log(`Removed (moved to trash): ${removedCount}`);
    console.log(`Remaining files: ${files.length - removedCount}`);
}

main();
