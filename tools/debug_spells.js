
const SPELL_DATA = {
    'detect magic': { level: 1 },
    'mage hand': { level: 0 },
    'fireball': { level: 3 },
    'ray of frost': { level: 0 },
};

function normalizeSpellName(str) {
    return str.toLowerCase()
        .replace(/\//g, 'l')
        .replace(/1/g, 'l')
        .replace(/\|/g, 'l')
        .replace(/0/g, 'o')
        .replace(/[^a-z]/g, '');
}

const NORMALIZED_SPELL_MAP = {};
Object.keys(SPELL_DATA).forEach(k => {
    NORMALIZED_SPELL_MAP[normalizeSpellName(k)] = k;
});

function findSpellInLibrary(name) {
    if (!name) return null;
    const cleanName = name.toLowerCase().trim();
    if (SPELL_DATA[cleanName]) return { name: cleanName, ...SPELL_DATA[cleanName] };
    const norm = normalizeSpellName(name);
    const matchedKey = NORMALIZED_SPELL_MAP[norm];
    if (matchedKey) return { name: matchedKey, ...SPELL_DATA[matchedKey] };
    return null;
}

function parseMonsterActions(description) {
  const text = description.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  
  const rawActions = [];
  let currentAction = null;
  const actionStartRegex = /^([A-Z][\w\s\(\)\/\-\'\’\–\—]{1,50})\.(.*)/;

  for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      const startMatch = trimmed.match(actionStartRegex);
      if (startMatch) {
          if (currentAction) rawActions.push(currentAction);
          currentAction = {
              name: startMatch[1].trim(),
              text: startMatch[2].trim(),
              fullText: trimmed,
          };
      } else {
          if (currentAction) {
              currentAction.fullText += "\n" + trimmed;
          }
      }
  }
  if (currentAction) rawActions.push(currentAction);

  console.log("Raw Actions Found:", rawActions.length);
  rawActions.forEach(a => console.log(`- ${a.name}`));

  const parsedActions = rawActions.map(action => {
      const details = {
          name: action.name,
          spells: [],
      };

      if (action.name.toLowerCase().match(/spel.*?cast/i) || action.name.toLowerCase().includes('innate')) {
          console.log(`\nAnalyzing Spellcasting Action: "${action.name}"`);
          console.log(`Full Text Length: ${action.fullText.length}`);
          
          const usageRegex = /(?:At will|Constant|\d+\s*(?:\/|f)?\s*day(?:\s*each)?|Cantrips|(?:\d+)(?:st|nd|rd|th)?\s*level)(?:[^:]*)?\s*:/gi;
          let uMatch;
          const usageIndices = [];
          while ((uMatch = usageRegex.exec(action.fullText)) !== null) {
              console.log(`  Found Header: "${uMatch[0]}" at index ${uMatch.index}`);
              usageIndices.push({ index: uMatch.index, label: uMatch[0] });
          }

          if (usageIndices.length > 0) {
              for (let i = 0; i < usageIndices.length; i++) {
                  const start = usageIndices[i].index + usageIndices[i].label.length;
                  const end = (i + 1 < usageIndices.length) ? usageIndices[i+1].index : action.fullText.length;
                  const chunk = action.fullText.substring(start, end).replace(/\n/g, ' ').trim();
                  
                  console.log(`  Chunk [${i}]: "${chunk}"`);
                  
                  const spells = chunk.split(',').map(s => s.trim().replace(/\.$/, ''));
                  
                  spells.forEach(s => {
                      let spellName = s.replace(/\(.*\)/, '').trim();
                      if (spellName.toLowerCase().startsWith('following spells')) return;
                      const cleanHeader = usageIndices[i].label.replace(':', '').trim().toLowerCase();
                      if (spellName.toLowerCase() === cleanHeader) return;
                      
                      if (spellName && spellName.length > 2) {
                          const found = findSpellInLibrary(spellName);
                          console.log(`    Checking "${spellName}" -> Found: ${found ? found.name : 'No'}`);
                          if (found) {
                              details.spells.push({ name: found.name });
                          }
                      }
                  });
              }
          }
      }
      return details;
  });
  
  return parsedActions;
}

const input = `Spel/casting. The lich is an 18th-level spellcaster. Its 
 spellcasting abi lity is Intelligence (spell save DC 20, +12 
 to hit with spell attacks). The lich has the followi ng wizard 
 spells prepared: 
 Cantrips (at will): mage hand, prestidigitation, ray of f rost 
 1st level (4 slots): detect magic, magic missile, shield, 
 thunderwave 
 2nd level (3 slots): detect thoughts, invisibility, Me/f's acid arrow, 
 mirror image 
 3rd level (3 slots): animate dead, counterspell, dispel 
 magic, fireball 
 4th level (3 slots): blight, dimension door 
 5th level (3 slots): c/oudki/1, scrying 
 6th level (1 slot): disintegrate, globe of invulnerability 
 7th level (1 slot): fi nger of death, plane shift 
 8th level (1 slot): dominate monster, power word stun 
 9th level (1 slot): power word kill`;

parseMonsterActions(input);
