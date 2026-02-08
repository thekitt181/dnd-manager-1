
const SPELL_DATA = {
    'fireball': { level: 3, damage: '8d6', type: 'fire', save: 'DEX', aoe: { size: 20, type: 'radius' } },
    'detect magic': { level: 1 },
    'wall of fire': { level: 4, damage: '5d8', type: 'fire', save: 'DEX', aoe: { size: 60, type: 'wall' } },
    'hold monster': { level: 5, save: 'WIS' },
};

function parseMonsterActions(description) {
  // Normalize newlines
  const text = description.replace(/\r\n/g, '\n');
  
  const rawActions = [{
      name: "Innate Spellcasting",
      fullText: text,
      section: "traits",
      isTrait: true
  }];

  // Parse details
  const parsedActions = rawActions.map(action => {
      const details = {
          name: action.name,
          originalText: action.fullText,
          spells: [],
      };
      
      console.log("Parsing Action Text:", JSON.stringify(action.fullText));

      // Spells (if Spellcasting or Innate)
      if (action.name.toLowerCase().includes('spellcasting') || action.name.toLowerCase().includes('innate')) {
          
          // 2. Look for Spell Lists (Innate/Standard)
          const usageRegex = /(?:At will|Constant|\d+\s*(?:\/|f)?\s*day(?:\s*each)?)\s*:/gi;
          let uMatch;
          const usageIndices = [];
          while ((uMatch = usageRegex.exec(action.fullText)) !== null) {
              console.log("Found Header:", uMatch[0], "at index", uMatch.index);
              usageIndices.push({ index: uMatch.index, label: uMatch[0] });
          }

          if (usageIndices.length > 0) {
              for (let i = 0; i < usageIndices.length; i++) {
                  const start = usageIndices[i].index + usageIndices[i].label.length;
                  const end = (i + 1 < usageIndices.length) ? usageIndices[i].index : action.fullText.length;
                  const chunk = action.fullText.substring(start, end).trim();
                  
                  console.log(`Chunk [${i}]:`, JSON.stringify(chunk));

                  // Split by comma, remove noise
                  const spells = chunk.split(',').map(s => s.trim().replace(/\.$/, '')); // remove trailing dot
                  
                  spells.forEach(s => {
                      // Basic cleanup
                      let spellName = s.replace(/\(.*\)/, '').trim(); // Remove parens like (self only)
                      
                      // Remove common noise
                      if (spellName.toLowerCase().startsWith('following spells')) return;
                      
                      // Check if the spell name is actually just the header repeated or noise
                      const cleanHeader = usageIndices[i].label.replace(':', '').trim().toLowerCase();
                      if (spellName.toLowerCase() === cleanHeader) return;
                      
                      console.log("  Processing Spell Candidate:", JSON.stringify(spellName));

                      if (spellName && spellName.length > 2) {
                          // Check if already added via dice matcher
                          if (!details.spells.find(ex => ex.name.includes(spellName))) {
                              const aoe = SPELL_DATA[spellName.toLowerCase()] ? SPELL_DATA[spellName.toLowerCase()].aoe : undefined;
                              console.log("    -> Added Spell:", spellName, "Found in Data:", !!SPELL_DATA[spellName.toLowerCase()]);
                              details.spells.push({ name: spellName, dice: null, label: usageIndices[i].label.replace(':', ''), aoe });
                          }
                      }
                  });
              }
          }
      }
    
    return details;
  }); 

  // Expand Spells into Actions
  const newSpellActions = [];
  parsedActions.forEach(action => {
      if (action.spells && action.spells.length > 0) {
          action.spells.forEach(spell => {
              const data = SPELL_DATA[spell.name.toLowerCase()];
              if (data) {
                   const newAction = {
                       name: `${spell.name} (${spell.label || 'Spell'})`,
                       section: 'actions', 
                   };
                   newSpellActions.push(newAction);
              }
          });
      }
  });
  
  return [...parsedActions, ...newSpellActions];
}

const input = `Innate Spellcasting. The pit fiend's spellcasting ability is Charisma (spell save DC 21). The pit fiend can innately cast the following spells, requiring no material co mponents: At will: detect magic, fireball
3fday each: hold monster, wall of fire`;

const results = parseMonsterActions(input);
console.log("Final Actions:", results.map(a => a.name));
