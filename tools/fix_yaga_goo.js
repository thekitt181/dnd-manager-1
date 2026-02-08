import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONSTERS_FILE = path.join(__dirname, '../src/monsters.json');

if (!fs.existsSync(MONSTERS_FILE)) {
    console.error(`File not found: ${MONSTERS_FILE}`);
    process.exit(1);
}

const monsters = JSON.parse(fs.readFileSync(MONSTERS_FILE, 'utf8'));

let fixedCount = 0;
monsters.forEach(m => {
    if (m.name === 'YAGA GOO') {
        if (m.image) {
            console.log(`Removing image from YAGA GOO: ${m.image}`);
            m.image = null;
            fixedCount++;
        } else {
            console.log(`YAGA GOO found but has no image.`);
        }
    }
});

if (fixedCount > 0) {
    fs.writeFileSync(MONSTERS_FILE, JSON.stringify(monsters, null, 2));
    console.log(`Fixed ${fixedCount} entries.`);
} else {
    console.log("No changes needed.");
}
