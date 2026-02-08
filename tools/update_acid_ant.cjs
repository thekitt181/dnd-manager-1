
const fs = require('fs');
const path = require('path');

const monstersPath = path.join(__dirname, '../src/monsters.json');
const base64Path = path.join(__dirname, '../acid_ant_base64.txt');

try {
    const monstersData = fs.readFileSync(monstersPath, 'utf8');
    const monsters = JSON.parse(monstersData);
    
    // Read base64 data and trim whitespace
    let base64Image = fs.readFileSync(base64Path, 'utf8').trim();
    // Ensure it has the prefix
    if (!base64Image.startsWith('data:image')) {
        base64Image = 'data:image/jpeg;base64,' + base64Image;
    }

    let updated = false;
    for (const monster of monsters) {
        if (monster.name === 'ACID ANT') {
            monster.image = base64Image;
            updated = true;
            console.log('Updated ACID ANT image.');
            break;
        }
    }

    if (updated) {
        fs.writeFileSync(monstersPath, JSON.stringify(monsters, null, 2));
        console.log('Successfully wrote to monsters.json');
    } else {
        console.error('ACID ANT entry not found!');
    }

} catch (err) {
    console.error('Error updating monsters.json:', err);
}
