import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONSTERS_FILE = path.join(__dirname, '../src/monsters.json');

if (!fs.existsSync(MONSTERS_FILE)) {
    console.error('Monsters file not found!');
    process.exit(1);
}

const monsters = JSON.parse(fs.readFileSync(MONSTERS_FILE, 'utf8'));
let fixedCount = 0;

const MONSTERS_TO_FIX = [
    "WASTELAND DRAGON",
    "WASTELAND DRAGON WYRMLING",
    "YOUNG WASTELAND DRAGON",
    "ADULT WASTELAND DRAGON",
    "ANCIENT WASTELAND DRAGON",
    "ANCIENT LIGHT DRAGON",
    "ADULT LIGHT DRAGON",
    "LIGHT DRAGON WYRMLING"
];

monsters.forEach(m => {
    if (MONSTERS_TO_FIX.includes(m.name)) {
        if (m.image) {
            console.log(`Removing incorrect image from ${m.name}: ${m.image}`);
            m.image = null;
            fixedCount++;
        }
    }
});

if (fixedCount > 0) {
    fs.writeFileSync(MONSTERS_FILE, JSON.stringify(monsters, null, 2));
    console.log(`Fixed ${fixedCount} entries.`);
} else {
    console.log('No entries needed fixing.');
}
