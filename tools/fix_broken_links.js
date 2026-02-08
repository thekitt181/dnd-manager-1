import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONSTERS_FILE = path.join(__dirname, '../src/monsters.json');
const IMAGES_DIR = path.join(__dirname, '../public/images');

function main() {
    console.log('Loading monsters.json...');
    const monsters = JSON.parse(fs.readFileSync(MONSTERS_FILE, 'utf-8'));

    let brokenCount = 0;
    monsters.forEach(m => {
        if (m.image) {
            // Extract filename
            const parts = m.image.split('/');
            const filename = parts[parts.length - 1];
            const filePath = path.join(IMAGES_DIR, filename);

            if (!fs.existsSync(filePath)) {
                // console.log(`Broken link found: ${filename} (Monster: ${m.name})`);
                m.image = null;
                brokenCount++;
            }
        }
    });

    if (brokenCount > 0) {
        console.log(`Found and fixed ${brokenCount} broken links.`);
        fs.writeFileSync(MONSTERS_FILE, JSON.stringify(monsters, null, 2));
        console.log('monsters.json updated.');
    } else {
        console.log('No broken links found.');
    }
}

main();
