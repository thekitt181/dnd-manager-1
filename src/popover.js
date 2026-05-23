import monsters from './monsters.json';
import items from './items.json';
import SPELL_DATA from './spells.json';
import Tesseract from 'tesseract.js';
import OBR, { buildImage, buildShape, buildCurve, buildText } from '@owlbear-rodeo/sdk';
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const EXTENSION_VERSION = "1.4"; // Version indicator for debugging
const CHANNEL_ID = 'com.dnd-extension.rolls';

let spawnPosition = null; // Global spawn position from URL params

const ICON_SVG = "https://raw.githubusercontent.com/FortAwesome/Font-Awesome/master/svgs/solid/dice-d20.svg";

// Helper: Normalize string for fuzzy matching (handles OCR errors)
function normalizeSpellName(str) {
    return str.toLowerCase()
        .replace(/\//g, 'l')   // Replace / with l (c/oudki/l -> cloudkill)
        .replace(/1/g, 'l')    // Replace 1 with l (c/oudki/1 -> cloudkill)
        .replace(/\|/g, 'l')   // Replace | with l
        .replace(/0/g, 'o')    // Replace 0 with o
        .replace(/[^a-z]/g, ''); // Remove all non-alpha (spaces, punctuation)
}

// Pre-compute normalized keys for fast lookup
const NORMALIZED_SPELL_MAP = {};
Object.keys(SPELL_DATA).forEach(k => {
    NORMALIZED_SPELL_MAP[normalizeSpellName(k)] = k;
});

function findSpellInLibrary(name) {
    if (!name) return null;
    const cleanName = name.toLowerCase().trim();
    
    // 1. Exact Match
    if (SPELL_DATA[cleanName]) return { name: cleanName, ...SPELL_DATA[cleanName] };
    
    // 2. Normalized Fuzzy Match
    const norm = normalizeSpellName(name);
    const matchedKey = NORMALIZED_SPELL_MAP[norm];
    if (matchedKey) return { name: matchedKey, ...SPELL_DATA[matchedKey] };
    
    return null;
}

// Helper: Parse dice expression and roll
function rollDice(expression) {
  // Supports "XdY+Z", "XdY-Z", "XdY"
  const cleanExpr = expression.replace(/\s/g, '').toLowerCase();
  const match = cleanExpr.match(/(\d+)d(\d+)(?:([+-])(\d+))?/);
  
  if (!match) return null;

  const count = parseInt(match[1], 10);
  const sides = parseInt(match[2], 10);
  const operator = match[3] || '+';
  const modifier = match[4] ? parseInt(match[4], 10) : 0;

  const rolls = [];
  let subtotal = 0;
  for (let i = 0; i < count; i++) {
      const roll = Math.floor(Math.random() * sides) + 1;
      rolls.push(roll);
      subtotal += roll;
  }

  const total = operator === '+' ? subtotal + modifier : subtotal - modifier;
  
  return {
      total,
      rolls,
      formula: expression,
      details: `[${rolls.join(',')}] ${operator} ${modifier}`
  };
}

// Helper: Parse actions from description
function parseMonsterActions(description) {
  if (!description) return [];
  
  // Normalize newlines
  const text = description.replace(/\r\n/g, '\n');
  
  // Global Spell Stats (DC, To Hit)
  const globalSaveDC = (text.match(/spell save DC (\d+)/i) || [])[1];
  const globalToHit = (text.match(/([+-]\d+)\s*to\s*hit\s*with\s*spell/i) || [])[1];

  const lines = text.split('\n');
  
  const rawActions = [];
  let currentAction = null;
  let section = 'traits'; // 'traits', 'actions', 'reactions', 'legendary'
  
  // Regex to detect start of a new action: "Name."
  // Must start with capital letter, end with period.
  // We accept names with parens like "Recharge (5-6)" and apostrophes "Sleeper's Slap"
  // Also support en-dash (–) and em-dash (—) which are common in PDF copy-pastes
  const actionStartRegex = /^([A-Z][\w\s\(\)\/\-\'\’\–\—]{1,50})\.(.*)/;
  // Stats to ignore if they match the regex
  const ignoredHeaders = new Set(['Speed', 'Skills', 'Senses', 'Languages', 'Challenge', 'Saving Throws', 'Damage Immunities', 'Condition Immunities', 'Damage Resistances', 'Damage Vulnerabilities']);

  let hasSeenActionHeader = false;

  for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      // Check for headers to toggle section context
      if (trimmed === 'ACTIONS') {
          section = 'actions';
          hasSeenActionHeader = true;
          continue;
      }
      if (trimmed === 'LEGENDARY ACTIONS') {
          section = 'legendary';
          hasSeenActionHeader = true;
          continue;
      }
      if (trimmed === 'REACTIONS') {
          section = 'reactions';
          hasSeenActionHeader = true;
          continue;
      }

      // Stop parsing if we hit a page footer or what looks like the start of a new monster entry
      // This prevents bleeding into the next monster's flavor text
      if (trimmed.includes('CREATURE CODEX') || trimmed.includes('TOME OF BEASTS') || /^\d+$/.test(trimmed)) {
          if (hasSeenActionHeader) {
              // If we've already seen actions, a footer likely means the end of this monster's entry
              if (currentAction) {
                  rawActions.push(currentAction);
                  currentAction = null;
              }
              break; 
          }
          // If we haven't seen actions yet, it might just be a footer in the description/traits area
          // We'll continue but reset the action context just in case
          continue;
      }
      
      const startMatch = trimmed.match(actionStartRegex);
      
      if (startMatch) {
          const name = startMatch[1].trim();
          
          // Ignore standard stat lines that might match the regex
          // Also ignore lines that start with ability scores or look like part of a spellcasting description (e.g. "Wisdom (spell save DC 13)")
          if (ignoredHeaders.has(name) || 
              name.startsWith('STR') || name.startsWith('DEX') || 
              name.includes('spell save DC') ||
              /^(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s*\(/.test(name)) {
              
              if (currentAction) {
                  // Append to current action if it looks like a stat line in description
                  if (name.includes('spell save DC') || /^(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s*\(/.test(name)) {
                       currentAction.text += " " + trimmed;
                       currentAction.fullText += "\n" + trimmed;
                       continue;
                  }
                  
                  rawActions.push(currentAction);
                  currentAction = null;
              }
              continue;
          }

          if (currentAction) rawActions.push(currentAction);
          currentAction = {
              name: name,
              text: startMatch[2].trim(),
              fullText: trimmed,
              section: section,
              isTrait: section === 'traits'
          };
      } else {
          if (currentAction) {
              currentAction.text += " " + trimmed;
              currentAction.fullText += "\n" + trimmed;
          }
      }
  }
  if (currentAction) rawActions.push(currentAction);

  // Parse details
  const parsedActions = rawActions.map(action => {
      const details = {
          name: action.name,
          originalText: action.fullText,
          damages: [],
          spells: [],
          section: action.section,
          isTrait: action.isTrait
      };
      
      // Attack
      const attackMatch = action.fullText.match(/([+-]\d+)\s*to\s*hit/);
      if (attackMatch) {
          details.toHit = parseInt(attackMatch[1], 10);
      }
      
      // Save
      // Supports "DC 15 Wisdom saving throw" or "DC 15 Wisdom save"
      // Also handles potential newlines between parts
      const saveMatch = action.fullText.match(/DC\s*(\d+)\s*(\w+)\s*(?:saving\s*throw|save)/i);
      if (saveMatch) {
          details.save = {
              dc: parseInt(saveMatch[1], 10),
              stat: saveMatch[2]
          };
      }

      // AoE Detection
      // Matches: "15-foot cone", "20-foot radius", "60-foot line", "10-foot cube"
      const aoeMatch = action.fullText.match(/(\d+)-(?:foot|ft\.?)\s+(cone|line|cube|sphere|radius|cylinder)/i);
      if (aoeMatch) {
          details.aoe = {
              size: parseInt(aoeMatch[1], 10),
              type: aoeMatch[2].toLowerCase()
          };
      }

      // Damage (Find all occurrences)
      // Matches: "Hit: 5 (1d10) fire damage", "take 5 (1d10) fire damage", "takes 5 (1d10) fire damage", "plus 2 (1d4) acid damage"
      // Allows punctuation between type and "damage" (e.g. "bludgeoning, damage")
      // Uses non-greedy capture ([\s\S]*?) for type to handle complex descriptions including newlines like "radiant (good...) or necrotic (evil \n eyes)"
      const damageRegex = /(?:Hit:|takes?|plus)\s*(?:\d+)?\s*\(((\d+d\d+)(?:\s*[+-]\s*\d+)?)\)\s*([\s\S]*?)\s*damage/gi;
      let match;
      while ((match = damageRegex.exec(action.fullText)) !== null) {
          details.damages.push({
              dice: match[1], // e.g. "1d10 + 5"
              type: match[3] || 'Damage' // e.g. "fire"
          });
      }

      // Spells (if Spellcasting or Innate)
      // Match "Spellcasting" (std), "Innate Spellcasting" (std), "Spel/casting" (OCR error)
      if (action.name.toLowerCase().match(/spel.*?cast/i) || action.name.toLowerCase().includes('innate')) {
          // 1. Look for "spellname (damage)" patterns e.g. "fire bolt (2d10)"
          const spellRegex = /([a-zA-Z\s]+?)\s*\(((\d+d\d+)(?:\s*[+-]\s*\d+)?)\)/g;
          let sMatch;
          while ((sMatch = spellRegex.exec(action.fullText)) !== null) {
              const name = sMatch[1].trim();
              const dice = sMatch[2];
              // Filter out common false positives
              if (name !== 'take' && name !== 'plus' && name !== 'Hit:') {
                   const found = findSpellInLibrary(name);
                   const aoe = found ? found.aoe : undefined;
                   details.spells.push({ name: found ? found.name : name, dice, aoe });
              }
          }

          // 2. Look for Spell Lists (Innate/Standard)
          // Matches "At will: spell, spell", "3/day each: spell, spell"
          // Handles "3fday" typo from OCR and optional "each"
          // Refined regex to be more permissive with spacing and OCR artifacts
          // Added \s* before : to handle spaces like "At will :"
          // Added support for "Cantrips", "1st level", "1st level (4 slots)"
          // Modified to capture multiline content until the next header or end of section
          const usageRegex = /(?:At will|Constant|\d+\s*(?:\/|f)?\s*day(?:\s*each)?|Cantrips|(?:\d+)(?:st|nd|rd|th)?\s*level)(?:[^:]*)?\s*:/gi;
          let uMatch;
          const usageIndices = [];
          while ((uMatch = usageRegex.exec(action.fullText)) !== null) {
              usageIndices.push({ index: uMatch.index, label: uMatch[0] });
          }

          if (usageIndices.length > 0) {
              for (let i = 0; i < usageIndices.length; i++) {
                  const start = usageIndices[i].index + usageIndices[i].label.length;
                  // Fix: use i+1 for the next index
                  const end = (i + 1 < usageIndices.length) ? usageIndices[i+1].index : action.fullText.length;
                  
                  // Extract the chunk and replace newlines with spaces to handle wrapped lines
                  // This fixes "thunderwave" or "mirror image" appearing on a new line being missed
                  const chunk = action.fullText.substring(start, end).replace(/\n/g, ' ').trim();
                  
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
                      
                      if (spellName && spellName.length > 2) {
                          // Check if already added via dice matcher
                          if (!details.spells.find(ex => ex.name.includes(spellName))) {
                              const found = findSpellInLibrary(spellName);
                              if (found) {
                                  // Use normalized name
                                  details.spells.push({ name: found.name, dice: null, label: usageIndices[i].label.split('(')[0].replace(':', '').trim(), aoe: found.aoe });
                              } else {
                                  // Keep original if not found, but try to infer AoE?
                                  // No, if not found, we can't do much.
                                  details.spells.push({ name: spellName, dice: null, label: usageIndices[i].label.split('(')[0].replace(':', '').trim() });
                              }
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
                       originalText: `Casts ${spell.name}. ${data.damage ? `Deals ${data.damage} ${data.type} damage.` : ''}`,
                       section: 'actions', // Force to actions list
                       isTrait: false,
                       toHit: (data.attack && globalToHit) ? parseInt(globalToHit, 10) : undefined,
                       save: (data.save && globalSaveDC) ? { dc: parseInt(globalSaveDC, 10), stat: data.save } : undefined,
                       damages: [],
                       spells: [],
                       aoe: data.aoe
                   };

                   if (data.damage) {
                       newAction.damages.push({ dice: data.damage, type: data.type });
                   }
                   if (data.secondary) {
                       newAction.damages.push({ dice: data.secondary.damage, type: data.secondary.type });
                   }
                   
                   newSpellActions.push(newAction);
              }
          });
      }
  });

  // Global Spell Discovery (Fallback)
  // Scan full text for any known spells not yet captured (e.g. mentioned in flavor text or non-standard headers)
  Object.keys(SPELL_DATA).forEach(spellKey => {
      // Use word boundary to avoid partial matches (e.g. "fear" in "fearful")
      // ALSO check for fuzzy matches in the text using our normalization map!
      // This is expensive, so maybe just check the keys we have?
      
      const regex = new RegExp(`\\b${spellKey}\\b`, 'i');
      if (regex.test(text)) {
           // Check if already present...
           const alreadyExists = [...parsedActions, ...newSpellActions].some(a => {
               if (a.spells && a.spells.some(s => s.name.toLowerCase() === spellKey)) return true;
               const lowerName = a.name.toLowerCase();
               if (lowerName === spellKey) return true;
               if (lowerName.startsWith(spellKey + ' ')) return true;
               if (lowerName.startsWith(spellKey + '(')) return true;
               return false;
           });

           if (!alreadyExists) {
               const data = SPELL_DATA[spellKey];
               const displayName = spellKey.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
               
               const newAction = {
                   name: `${displayName} (Detected)`,
                   originalText: `Mentioned in description. ${data.damage ? `Deals ${data.damage} ${data.type} damage.` : ''}`,
                   section: 'actions',
                   isTrait: false,
                   toHit: (data.attack && globalToHit) ? parseInt(globalToHit, 10) : undefined,
                   save: (data.save && globalSaveDC) ? { dc: parseInt(globalSaveDC, 10), stat: data.save } : undefined,
                   damages: [],
                   spells: [], 
                   aoe: data.aoe
               };
               
               if (data.damage) {
                   newAction.damages.push({ dice: data.damage, type: data.type });
               }
               if (data.secondary) {
                   newAction.damages.push({ dice: data.secondary.damage, type: data.secondary.type });
               }
               
               newSpellActions.push(newAction);
           }
      }
  });
  
  return [...parsedActions, ...newSpellActions];
}

// Helper: Parse stats object from JSON
function parseStatsObject(stats) {
  if (!stats) return [];
  const map = { str: 'STR', dex: 'DEX', con: 'CON', int: 'INT', wis: 'WIS', cha: 'CHA' };
  const order = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
  const result = [];
  
  for (const [key, val] of Object.entries(stats)) {
      const name = map[key.toLowerCase()];
      if (name) {
           const score = parseInt(val, 10);
           const mod = Math.floor((score - 10) / 2);
           result.push({ name, score, mod });
      }
  }
  
  return result.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
}

// Helper: Parse Ability Scores
function parseAbilities(text) {
  if (!text) return [];
  // Normalize text to handle newlines between Stat and Value
  // Also fix common OCR typos like 'lnt' -> 'Int'
  const normalized = text.replace(/\r\n/g, ' ').replace(/\n/g, ' ').replace(/\blnt\b/gi, 'Int');
  
  const abilities = [];
  const regex = /(STR|DEX|CON|INT|WIS|CHA|Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s*(\d+)\s*\(([+-]\d+)\)/gi;
  let match;
  
  // Map full names to short names
  const shortMap = {
      'Strength': 'STR', 'Dexterity': 'DEX', 'Constitution': 'CON',
      'Intelligence': 'INT', 'Wisdom': 'WIS', 'Charisma': 'CHA'
  };

  while ((match = regex.exec(normalized)) !== null) {
      let name = match[1].toUpperCase();
      if (shortMap[match[1]]) name = shortMap[match[1]]; // Normalize to STR, DEX etc
      
      // Avoid duplicates (if description repeats them)
      if (!abilities.find(a => a.name === name)) {
          abilities.push({
              name: name,
              score: parseInt(match[2], 10),
              mod: parseInt(match[3], 10)
          });
      }
  }

  // Fallback for "Block Format": STR DEX CON ... \n 10 (+0) 12 (+1) ...
  if (abilities.length === 0) {
      // Look for 6 consecutive stat blocks (e.g. "13 (+1) 6 (-2) ...")
      const blockRegex = /(\d+)\s*\(([+-]\d+)\)\s*(\d+)\s*\(([+-]\d+)\)\s*(\d+)\s*\(([+-]\d+)\)\s*(\d+)\s*\(([+-]\d+)\)\s*(\d+)\s*\(([+-]\d+)\)\s*(\d+)\s*\(([+-]\d+)\)/;
      const blockMatch = normalized.match(blockRegex);
      if (blockMatch) {
          const names = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
          for (let i = 0; i < 6; i++) {
              abilities.push({
                  name: names[i],
                  score: parseInt(blockMatch[i*2 + 1], 10),
                  mod: parseInt(blockMatch[i*2 + 2], 10)
              });
          }
      }
  }

  return abilities;
}

// Helper: Parse Saving Throws
function parseSavingThrows(text) {
  if (!text) return [];
  const normalized = text.replace(/\r\n/g, ' ').replace(/\n/g, ' ');
  
  // Look for "Saving Throws" followed by text until end of line, period, or next section
  const match = normalized.match(/Saving Throws\s+(.*?)(?=\.|Skills|Damage|Condition|Senses|Languages|Challenge|$)/i);
  if (!match) return [];
  
  // Fix common OCR typos like 'lnt' -> 'Int'
  const savesStr = match[1].replace(/\blnt\b/gi, 'Int');
  const saves = [];
  
  // Use regex to find all "Stat +Mod" pairs (handles commas or spaces)
  const saveRegex = /([a-zA-Z]+)\s*([+-]\d+)/g;
  let saveMatch;
  
  while ((saveMatch = saveRegex.exec(savesStr)) !== null) {
      saves.push({
          name: saveMatch[1],
          mod: parseInt(saveMatch[2], 10)
      });
  }
  return saves;
}

// Helper: Clean a single line of OCR artifacts
function cleanOcrLine(line) {
  if (!line) return '';
  let clean = line;
  
  // Step 1: Remove non-ASCII characters and common garbage symbols
  clean = clean.replace(/[^\x00-\x7F]/g, ' ');
  clean = clean.replace(/[|/\\[\]{}<>]/g, ' ');
  clean = clean.replace(/\s*[=+\-*#@!$%^&*()_+~`]+\s*/g, ' ');
  
  // Step 2: Fix specific OCR mistakes from the user's example
  clean = clean.replace(/\bToiLET\b/gi, 'Toilet');
  clean = clean.replace(/\bMimic ls\b/gi, 'Mimic');
  clean = clean.replace(/\bneutral ox\b/gi, 'neutral evil');
  clean = clean.replace(/\bneutral ox\?\b/gi, 'neutral evil');
  clean = clean.replace(/\bporcelain flesh\b/gi, 'porcelain armor');
  clean = clean.replace(/\bStats\/Sample Lore by @Snickelsox.*$/gi, '');
  
  // Step 3: Remove garbage that doesn't look like D&D stat block content
  // If line is mostly symbols/garbage, return empty string
  const alphaCount = (clean.match(/[a-zA-Z]/g) || []).length;
  const totalCount = clean.length;
  if (totalCount > 0 && alphaCount / totalCount < 0.3) {
    return ''; // Less than 30% letters → probably garbage
  }
  
  // Step 4: Collapse multiple spaces and trim
  clean = clean.replace(/\s+/g, ' ').trim();
  
  return clean;
}

// Helper: Parse CR string to number
function parseCR(crString) {
  if (!crString) return -1;
  const str = crString.trim();
  if (str === '0') return 0;
  if (str === '—' || str === '-') return 0; // Handle dash
  
  if (str.includes('/')) {
      const parts = str.split('/');
      if (parts.length === 2) {
          return parseInt(parts[0], 10) / parseInt(parts[1], 10);
      }
  }
  return parseFloat(str);
}

// Helper: Parse full stat block text
function parseStatBlock(text) {
  if (!text) return {};
  const result = {};
  
  const knownDeityNames = ['Anansi', 'Baba Yaga', 'Batara Kala', 'Freyja', 'Fuji', 'Hekate', 'Inti', 'Ishtar', 'Mazu', 'Nayenezgani', 'Shango', 'Shiva', 'Tchernobog', 'Tengri', 'Turan', 'Viviene'];
  
  // Clean each line individually with cleanOcrLine!
  const cleanLines = text.split('\n').map(line => cleanOcrLine(line)).filter(line => line.length > 0);
  const normalized = cleanLines.join(' '); // Join all clean lines into a single string
  
  console.log('parseStatBlock - cleaned text:', normalized.substring(0, 500));
  
  // 1. Parse Name and Type - PRIORITIZE KNOWN DEITY NAMES FIRST!
  // Split into lines (OCR might merge lines)
  const allLines = normalized.split(/(?<=\.)\s+(?=[A-Z])/g).join('\n').split('\n').map(line => line.trim()).filter(line => line.length > 0);
  let lines = allLines;
  
  // FIRST: Try to find the name using the BEST patterns FIRST
  let foundNameFromBestPattern = false;
  
  // PATTERN 0: FIRST CHECK ALL LINES FOR KNOWN DEITY NAMES - THIS IS #1 PRIORITY!
  for (const line of allLines) {
    for (const deityName of knownDeityNames) {
      if (line.toLowerCase().includes(deityName.toLowerCase())) {
        // If the line is JUST the deity name, use that
        if (line.toLowerCase().trim() === deityName.toLowerCase().trim()) {
          result.name = deityName;
          console.log('✅✅✅✅✅ Found EXACT deity name:', result.name);
          foundNameFromBestPattern = true;
          break;
        }
        // If the line contains the deity name, extract just the name
        const idx = line.toLowerCase().indexOf(deityName.toLowerCase());
        if (idx !== -1) {
          result.name = deityName;
          console.log('✅✅✅✅✅ Found deity name in line:', result.name);
          foundNameFromBestPattern = true;
          break;
        }
      }
    }
    if (foundNameFromBestPattern) break;
  }
  
  // Pattern 1: "The [Name] can take..." (legendary actions) - but ONLY if we didn't find a deity name
  if (!foundNameFromBestPattern) {
    const legendaryNameMatch = normalized.match(/The\s+([\w\s]+?)\s+can take/i);
    if (legendaryNameMatch && legendaryNameMatch[1]) {
      result.name = legendaryNameMatch[1].trim();
      console.log('Found name from legendary actions:', result.name);
      foundNameFromBestPattern = true;
    }
  }
  
  // Pattern 2: "Adult/Ancient/Young [Monster]" anywhere in text
  if (!foundNameFromBestPattern) {
    const ageMonsterMatch = normalized.match(/(?:Adult|Ancient|Young|Wyrm|Wyrmling|Great\s+Wyrm)\s+[\w\s]+?(?:Dragon|Demon|Devil|Goblin|Orc|Beholder|Lich|Vampire|Werewolf|Zombie|Skeleton|Ghost|Spirit|Elemental|Fey|Fiend|Celestial|Monstrosity|Beast|Humanoid|Plant|Ooze|Construct|Undead)/i);
    if (ageMonsterMatch) {
      result.name = ageMonsterMatch[0].trim();
      console.log('Found name from age pattern:', result.name);
      foundNameFromBestPattern = true;
    }
  }
  
  // Filter out lines that are just action/trait names (end with period, no stats) for the rest
  lines = allLines.filter(line => {
    const isProbablyAction = line.endsWith('.') && !line.includes('Armor') && !line.includes('HP') && 
                            !line.match(/\b\d+\b/) && !line.match(/\b(STR|DEX|CON|INT|WIS|CHA)\b/i) &&
                            line.length < 80;
    return !isProbablyAction;
  });
  
  // Try to find a name - but only if we didn't find it from a good pattern already
  let foundName = foundNameFromBestPattern;
  
  if (!foundName) {
    // Common monster name patterns
    const monsterNameKeywords = ['Dragon', 'Dragon', 'Goblin', 'Orc', 'Demon', 'Devil', 'Beholder', 'Lich', 'Vampire', 'Werewolf', 'Zombie', 'Skeleton', 'Ghost', 'Spirit', 'Elemental', 'Fey', 'Fiend', 'Celestial', 'Monstrosity', 'Beast', 'Humanoid', 'Plant', 'Ooze', 'Construct', 'Undead'];
    
    for (let i = 0; i < Math.min(lines.length, 3); i++) {
      const line = lines[i];
      const hasMonsterKeyword = monsterNameKeywords.some(kw => line.toLowerCase().includes(kw.toLowerCase()));
      const hasSizeKeyword = ['Small', 'Medium', 'Large', 'Huge', 'Gargantuan', 'Tiny'].some(kw => line.toLowerCase().includes(kw.toLowerCase()));
      
      if (hasMonsterKeyword && !hasSizeKeyword) {
        result.name = line;
        foundName = true;
        break;
      }
    }
  }
  
  // If no clear name found, use first line (and it might be type too)
  if (!foundName) {
    // First, try to find the name anywhere in the entire normalized text
    const adultMatch = normalized.match(/(?:Adult|Ancient|Young|Wyrm|Wyrmling)\s+[\w\s]+?(?:Dragon|Demon|Devil|Goblin|Orc|Beholder|Lich|Vampire|Werewolf|Zombie|Skeleton|Ghost|Spirit|Elemental|Fey|Fiend|Celestial|Monstrosity|Beast|Humanoid|Plant|Ooze|Construct|Undead)/i);
    if (adultMatch) {
      result.name = adultMatch[0].trim();
      foundName = true;
    }
    
    // Also check for "The [Name] can take..." pattern
    if (!foundName) {
      const legendaryMatch = normalized.match(/The\s+([\w\s]+?)\s+can take/i);
      if (legendaryMatch && legendaryMatch[1]) {
        result.name = legendaryMatch[1].trim();
        foundName = true;
      }
    }
  }
  
  if (!foundName && lines.length > 0) {
    const firstLine = lines[0];
    if (!firstLine.toLowerCase().includes('hp') && !firstLine.toLowerCase().includes('ac') && !firstLine.match(/^(str|dex|con|int|wis|cha)/i)) {
      // Check if it's a type line (starts with size)
      const startsWithSize = /^(Small|Medium|Large|Huge|Gargantuan|Tiny)/i.test(firstLine);
      if (startsWithSize) {
        // This is a type line - try to extract a name from it or just use "Unknown Monster"
        result.type = firstLine;
        // Try to find name by looking for creature type keywords
        for (const kw of monsterNameKeywords) {
          const idx = firstLine.toLowerCase().indexOf(kw.toLowerCase());
          if (idx !== -1) {
            // Extract from before size to end of keyword
            let nameStart = 0;
            for (const size of ['Small', 'Medium', 'Large', 'Huge', 'Gargantuan', 'Tiny']) {
              const sizeIdx = firstLine.toLowerCase().indexOf(size.toLowerCase());
              if (sizeIdx !== -1 && sizeIdx < idx) {
                nameStart = sizeIdx + size.length + 1;
                break;
              }
            }
            result.name = firstLine.substring(nameStart, idx + kw.length).trim();
            foundName = true;
            break;
          }
        }
        if (!foundName) {
          result.name = "Unknown Monster";
        }
      } else {
        result.name = firstLine;
      }
    }
  }
  
  // 2. Parse Type (like "Gargantuan elemental (deity avatar), neutral")
  const typeMatch = normalized.match(/(Small|Medium|Large|Huge|Gargantuan|Tiny)\s+([a-zA-Z\s\(\)]+?)(?:,|$)/i);
  if (typeMatch) {
    result.type = typeMatch[0].trim();
  }
  
  // 3. FINAL GUARANTEED NAME CHECK - but only if we still don't have a name
  if (!result.name || result.name === "Unknown Monster") {
    const finalNameMatch = normalized.match(/(?:Adult|Ancient|Young|Wyrm|Wyrmling|Great\s+Wyrm)?\s*[\w\s]*?(?:Dragon|Demon|Devil|Goblin|Orc|Beholder|Lich|Vampire|Werewolf|Zombie|Skeleton|Ghost|Spirit|Elemental|Fey|Fiend|Celestial|Monstrosity|Beast|Humanoid|Plant|Ooze|Construct|Undead)/i);
    if (finalNameMatch) {
      result.name = finalNameMatch[0].trim();
    }
  }
  
  // 3. Parse AC - multiple formats (with or without colon)
  const acMatch = normalized.match(/(?:Armor Class|AC)\s*:?\s*(?:\(.*?\)\s*)?(\d+)/i);
  if (acMatch) {
    result.ac = parseInt(acMatch[1], 10);
  }
  
  // 4. Parse HP - multiple formats (with or without colon)
  const hpMatch = normalized.match(/(?:Hit Points|HP)\s*:?\s*(?:\(.*?\)\s*)?(\d+)/i);
  if (hpMatch) {
    result.hp = parseInt(hpMatch[1], 10);
  }
  
  // 5. Parse CR - multiple formats (with or without colon, with or without XP)
  const crMatch = normalized.match(/(?:Challenge Rating|Challenge|CR)\s*:?\s*(?:\d+(?:,\d+)*\s*XP)?\s*([0-9\/\-—]+)/i);
  if (crMatch) {
    result.cr = crMatch[1].trim();
  }
  
  // 6. Parse Ability Scores (STR, DEX, CON, INT, WIS, CHA)
  const abilities = parseAbilities(normalized);
  if (abilities.length > 0) {
    // Convert abilities array to an object for easy use
    result.stats = {};
    abilities.forEach(ab => {
      result.stats[ab.name.toLowerCase()] = ab.score;
    });
  }
  
  // 7. Parse Saving Throws
  const saves = parseSavingThrows(normalized);
  if (saves.length > 0) {
    result.savingThrows = saves;
  }
  
  // 8. Parse Skills
  const skillsMatch = normalized.match(/Skills\s+([^:]+?)(?=\.|\s*(Damage|Condition|Senses|Languages|Challenge|ACTIONS|TRAITS|REACTIONS|LEGENDARY))/i);
  if (skillsMatch && skillsMatch[1]) {
    result.skills = skillsMatch[1].trim();
  }
  
  // 9. Parse Senses
  const sensesMatch = normalized.match(/Senses\s+([^:]+?)(?=\.|\s*(Damage|Condition|Languages|Challenge|ACTIONS|TRAITS|REACTIONS|LEGENDARY))/i);
  if (sensesMatch && sensesMatch[1]) {
    result.senses = sensesMatch[1].trim();
  }
  
  // 10. Parse Languages
  const languagesMatch = normalized.match(/Languages\s+([^:]+?)(?=\.|\s*(Damage|Condition|Challenge|ACTIONS|TRAITS|REACTIONS|LEGENDARY))/i);
  if (languagesMatch && languagesMatch[1]) {
    result.languages = languagesMatch[1].trim();
  }
  
  // 11. Parse Damage Resistances
  const drMatch = normalized.match(/Damage Resistances\s+([^:]+?)(?=\.|\s*(Damage|Condition|Senses|Languages|Challenge|ACTIONS|TRAITS|REACTIONS|LEGENDARY))/i);
  if (drMatch && drMatch[1]) {
    result.damageResistances = drMatch[1].trim();
  }
  
  // 12. Parse Damage Immunities
  const diMatch = normalized.match(/Damage Immunities\s+([^:]+?)(?=\.|\s*(Damage|Condition|Senses|Languages|Challenge|ACTIONS|TRAITS|REACTIONS|LEGENDARY))/i);
  if (diMatch && diMatch[1]) {
    result.damageImmunities = diMatch[1].trim();
  }
  
  // 13. Parse Condition Immunities
  const ciMatch = normalized.match(/Condition Immunities\s+([^:]+?)(?=\.|\s*(Damage|Condition|Senses|Languages|Challenge|ACTIONS|TRAITS|REACTIONS|LEGENDARY))/i);
  if (ciMatch && ciMatch[1]) {
    result.conditionImmunities = ciMatch[1].trim();
  }
  
  console.log("parseStatBlock - result:", result);
  
  return result;
}

// PDF Extraction Functions
async function extractTextFromPDF(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async function(e) {
      try {
        const typedArray = new Uint8Array(e.target.result);
        const pdf = await pdfjsLib.getDocument({ data: typedArray }).promise;
        let fullText = '';
        
        console.log(`PDF has ${pdf.numPages} page(s)`);
        
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          
          // Group text items into lines by Y-coordinate!
          const linesMap = new Map();
          for (const item of textContent.items) {
            const y = Math.round(item.transform[5]);
            if (!linesMap.has(y)) {
              linesMap.set(y, []);
            }
            linesMap.get(y).push(item);
          }
          
          // Sort lines by Y (top to bottom)
          const sortedYs = Array.from(linesMap.keys()).sort((a, b) => b - a);
          
          // Get page height to calculate header/footer
          const viewport = page.getViewport({ scale: 1.0 });
          const pageHeight = viewport.height;
          
          // For each line: sort items by X and join to make text, skip header/footer
          let pageLines = [];
          for (const y of sortedYs) {
            // Skip if line is in header (top 10%) or footer (bottom 10%)
            const relativeY = y / pageHeight;
            if (relativeY > 0.9 || relativeY < 0.1) {
              continue;
            }
            
            const items = linesMap.get(y);
            items.sort((a, b) => a.transform[4] - b.transform[4]);
            const lineText = items.map(i => i.str).join('').trim();
            
            // Skip lines that look like page numbers or footers
            const isPageNumber = /^\s*\d+\s*$/.test(lineText); // Just a number
            const isFooter = /^page\s+\d+$/i.test(lineText) || /^chapter\s+\d+$/i.test(lineText);
            
            if (lineText.length > 0 && !isPageNumber && !isFooter) {
              pageLines.push(lineText);
            }
          }
          
          // If page has very little text, try OCR!
          let totalChars = pageLines.reduce((sum, line) => sum + line.length, 0);
          if (totalChars < 50) {
            console.log(`Page ${i} has only ${totalChars} chars, trying OCR...`);
            
            try {
              // Render page to canvas
              const viewport = page.getViewport({ scale: 2.0 });
              const canvas = document.createElement('canvas');
              const context = canvas.getContext('2d');
              canvas.width = viewport.width;
              canvas.height = viewport.height;
              
              await page.render({ canvasContext: context, viewport: viewport }).promise;
              
              // Use Tesseract to OCR the canvas
              const result = await Tesseract.recognize(
                canvas,
                'eng',
                {
                  logger: m => console.log(`OCR progress (page ${i}):`, m)
                }
              );
              
              const ocrText = result.data.text;
              pageLines = ocrText.split('\n').filter(line => line.trim().length > 0);
              console.log(`OCR got ${pageLines.length} lines, ${ocrText.length} chars`);
            } catch (ocrErr) {
              console.error(`OCR failed for page ${i}:`, ocrErr);
            }
          }
          
          // Add page break marker
          if (i > 1) {
            fullText += '\n---PAGE_BREAK---\n';
          }
          
          // Mark first line of page as TOP_OF_PAGE!
          if (pageLines.length > 0) {
            pageLines[0] = '---TOP_OF_PAGE---' + pageLines[0];
          }
          
          const pageText = pageLines.join('\n');
          fullText += pageText + '\n';
          
          console.log(`Extracted page ${i}: ${pageLines.length} lines, ${pageText.length} chars`);
        }
        
        console.log(`Total extracted text: ${fullText.length} chars`);
        resolve(fullText);
      } catch (err) {
        console.error('PDF extraction error:', err);
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function extractMonstersFromPDFText(text) {
  const extractedMonsters = [];
  
  const sizeKeywords = ['Small', 'Medium', 'Large', 'Huge', 'Gargantuan', 'Tiny'];
  const creatureTypes = [
    'aberration', 'beast', 'celestial', 'construct', 'dragon', 'elemental', 
    'fey', 'fiend', 'giant', 'humanoid', 'monstrosity', 'ooze', 'plant', 'undead'
  ];
  
  const stopKeywords = [
    'CREATURE CODEX', 'TOME OF BEASTS', 'MONSTER MANUAL', 
    'VOLO\'S GUIDE', 'MORDENKAINEN\'S', 'XANATHAR\'S',
    'TALES FROM THE YAWNING PORTAL', 'GHOSTS OF SALTMARSH',
    'APPENDIX', 'INDEX', 'CHAPTER', 'ENCOUNTERS'
  ];
  
  // Create a list of known monster names from our built-in monsters.json!
  const knownMonsterNames = new Set(
    monsters.map(m => m.name.toLowerCase())
  );
  console.log('Known monsters in index:', knownMonsterNames.size);
  
  // Process lines, track which are at top of page
  const processedLines = [];
  let isAtTopOfPage = false;
  
  const rawLines = text.split(/\n+/);
  for (let line of rawLines) {
    let trimmedLine = cleanOcrLine(line.trim()); // Clean the line with our helper!
    let lineIsTopOfPage = isAtTopOfPage;
    
    // Check if LINE STARTS with markers! (they're prepended now)
    if (trimmedLine.startsWith('---TOP_OF_PAGE---')) {
      lineIsTopOfPage = true;
      trimmedLine = trimmedLine.substring('---TOP_OF_PAGE---'.length).trim();
    }
    if (trimmedLine.startsWith('---PAGE_BREAK---')) {
      continue;
    }
    if (trimmedLine.length === 0) continue;
    
    // Skip garbage lines (OCR artifacts)
    const garbagePatterns = [
      /^[|/\\[\]{}<>()=\-+*#@!$%^&*_~`]+$/, // Only symbols
      /^[a-zA-Z0-9]{1,3}\s*[|/\\[\]{}<>()=\-+*#@!$%^&*_~`]+$/, // Few chars + symbols
      /^Ba\s+C2\s+CREE/i,
      /^VEE\s+Cl\s+rE/i,
      /^PETERS$/i
    ];
    
    let isGarbage = false;
    for (const pattern of garbagePatterns) {
      if (pattern.test(trimmedLine)) {
        isGarbage = true;
        break;
      }
    }
    
    if (isGarbage) continue;
    
    processedLines.push({
      text: trimmedLine,
      isTopOfPage: lineIsTopOfPage
    });
    isAtTopOfPage = false;
  }
  
  console.log(`extractMonstersFromPDFText: ${processedLines.length} lines to process`);
  
  let buffer = [];
  let foundPotentialStart = false;
  let foundMonsterNameLine = false;
  let foundSizeTypeLine = false;
  
  // Check if a line is a potential monster start
  const isMonsterStart = (line, idx, processedLines) => {
    const lineLower = line.toLowerCase();
    const lineTrimmed = line.trim();
    
    // Check if this line is a "size + type" line (key for monster stat blocks)
    const hasSizeKeyword = sizeKeywords.some(kw => 
      lineTrimmed.startsWith(kw) || lineLower.includes(` ${kw.toLowerCase()} `)
    );
    const hasCreatureType = creatureTypes.some(ct => lineLower.includes(ct));
    
    if (hasSizeKeyword && hasCreatureType) {
      return true;
    }
    
    // Check if this line is a known monster name
    if (knownMonsterNames.has(lineLower)) {
      return true;
    }
    
    // Check if this line is ALL CAPS or looks like a title (possible monster name)
    // and the NEXT line is a size + type line
    if (idx < processedLines.length - 1) {
      const nextLine = processedLines[idx + 1].text;
      const nextLineLower = nextLine.toLowerCase();
      const nextHasSize = sizeKeywords.some(kw => 
        nextLine.startsWith(kw) || nextLineLower.includes(` ${kw.toLowerCase()} `)
      );
      const nextHasCreatureType = creatureTypes.some(ct => nextLineLower.includes(ct));
      
      if (nextHasSize && nextHasCreatureType) {
        // If next line is size+type, this line is likely the monster name
        return true;
      }
    }
    
    return false;
  };
  
  // Check if we should end the current monster
  const shouldEndMonster = (idx, processedLines, currentBuffer) => {
    if (idx >= processedLines.length - 1) {
      return true;
    }
    
    const line = processedLines[idx].text;
    const lineUpper = line.toUpperCase();
    
    // Check for stop keywords
    if (stopKeywords.some(kw => lineUpper.includes(kw))) {
      return true;
    }
    
    // Check if next line is a new monster start
    if (isMonsterStart(processedLines[idx + 1].text, idx + 1, processedLines)) {
      return true;
    }
    
    // Safety check: buffer is way too long
    if (currentBuffer.length > 500) {
      return true;
    }
    
    return false;
  };
  
  for (let i = 0; i < processedLines.length; i++) {
    const lineObj = processedLines[i];
    const line = lineObj.text;
    
    if (!foundPotentialStart) {
      if (isMonsterStart(line, i, processedLines)) {
        console.log(`Found potential monster start at line ${i}:`, line.substring(0, 100));
        foundPotentialStart = true;
        foundMonsterNameLine = false;
        foundSizeTypeLine = false;
        buffer = [line];
      }
    } else {
      buffer.push(line);
      
      if (shouldEndMonster(i, processedLines, buffer)) {
        console.log(`Ending monster at line ${i}, buffer length: ${buffer.length}`);
        
        const monsterText = buffer.join('\n');
        const parsed = parseStatBlock(monsterText);
        
        // Only add if we have at least a name or a size+type
        if (parsed.name || (parsed.ac && parsed.hp)) {
          extractedMonsters.push({
            rawText: monsterText,
            parsed: parsed
          });
          console.log('✅✅✅ Added monster:', parsed.name || 'Unknown');
        }
        
        buffer = [];
        foundPotentialStart = false;
      }
    }
  }
  
  // Add the last monster if we were still building one
  if (foundPotentialStart && buffer.length > 0) {
    const monsterText = buffer.join('\n');
    const parsed = parseStatBlock(monsterText);
    
    if (parsed.name || (parsed.ac && parsed.hp)) {
      extractedMonsters.push({
        rawText: monsterText,
        parsed: parsed
      });
    }
  }
  
  console.log(`extractMonstersFromPDFText: Found ${extractedMonsters.length} monsters total`);
  
  // Deduplicate by name, keeping the first one
  const seenNames = new Set();
  const uniqueMonsters = [];
  for (const monster of extractedMonsters) {
    const name = monster.parsed?.name || '';
    if (name && !seenNames.has(name.toLowerCase())) {
      seenNames.add(name.toLowerCase());
      uniqueMonsters.push(monster);
    }
  }
  
  console.log(`extractMonstersFromPDFText: Unique monsters: ${uniqueMonsters.length}`);
  return uniqueMonsters;
}

function saveExtractedMonstersToGlobal(monsters) {
  try {
    const existing = JSON.parse(localStorage.getItem('dnd_extension_extracted_monsters') || '[]');
    
    // Deduplicate: keep only new monsters not already in existing
    const seenNames = new Set(existing.map(m => m.parsed?.name?.toLowerCase() || ''));
    const newMonsters = monsters.filter(m => {
      const name = m.parsed?.name?.toLowerCase() || '';
      if (name && !seenNames.has(name)) {
        seenNames.add(name);
        return true;
      }
      return false;
    });
    
    const all = [...existing, ...newMonsters];
    localStorage.setItem('dnd_extension_extracted_monsters', JSON.stringify(all));
    return newMonsters.length;
  } catch (e) {
    console.error('Failed to save extracted monsters:', e);
    return 0;
  }
}

function getExtractedMonstersFromGlobal() {
  try {
    return JSON.parse(localStorage.getItem('dnd_extension_extracted_monsters') || '[]');
  } catch (e) {
    return [];
  }
}

// AI Extraction with mlvoca.com (free, no API key)
async function extractWithAI(text) {
  const systemPrompt = `You are a D&D 5e stat block and item extractor. Extract all monsters and magic items from the provided text. 
For each monster, extract: name, hp, ac, cr, type, and the full stat block text.
For each magic item, extract: name, type, rarity, and the full item description text.
Return a JSON object with two arrays: "monsters" and "items". Each entry should have the keys:
- For monsters: { "name": "...", "hp": "...", "ac": "...", "cr": "...", "type": "...", "rawText": "..." }
- For items: { "name": "...", "type": "...", "rarity": "...", "rawText": "..." }
Do not include any other text besides the JSON.`;

  const userPrompt = `${systemPrompt}\n\nExtract monsters and items from this text:\n\n${text.substring(0, 30000)}`; // Limit to avoid token issues

  try {
    const response = await fetch('https://mlvoca.com/api/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-r1:1.5b',
        prompt: userPrompt,
        stream: false,
        format: 'json'
      })
    });

    if (!response.ok) {
      throw new Error(`mlvoca API error: ${response.statusText}`);
    }

    const data = await response.json();
    let content = data.response.trim();
    
    // Extract JSON from response (in case there are extra characters)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not parse JSON from AI response');
    }

    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error('AI extraction failed:', error);
    throw error;
  }
}

// Basic item extraction (without AI)
function extractItemsFromPDFText(text) {
  const extractedItems = [];
  
  const rarityKeywords = ['common', 'uncommon', 'rare', 'very rare', 'legendary', 'artifact'];
  const itemTypeKeywords = ['weapon', 'armor', 'wondrous item', 'potion', 'scroll', 'ring', 'wand', 'staff', 'rod'];
  
  const processedLines = text.split(/\n+/).map(line => line.trim()).filter(line => line.length > 0);
  
  let buffer = [];
  let foundItemStart = false;
  
  for (let i = 0; i < processedLines.length; i++) {
    const line = processedLines[i];
    const lineLower = line.toLowerCase();
    
    if (!foundItemStart) {
      // Check if line is likely an item start (has rarity and item type)
      const hasRarity = rarityKeywords.some(r => lineLower.includes(r));
      const hasItemType = itemTypeKeywords.some(t => lineLower.includes(t));
      
      if (hasRarity && hasItemType) {
        foundItemStart = true;
        buffer = [line];
      }
    } else {
      buffer.push(line);
      
      // Check if we should end the item (when we hit another potential item or monster)
      const lineUpper = line.toUpperCase();
      const nextLine = i < processedLines.length - 1 ? processedLines[i + 1] : '';
      const nextLineLower = nextLine.toLowerCase();
      
      const shouldEnd = 
        buffer.length > 200 ||
        (nextLine && rarityKeywords.some(r => nextLineLower.includes(r)) && itemTypeKeywords.some(t => nextLineLower.includes(t)));
      
      if (shouldEnd) {
        const itemText = buffer.join('\n');
        
        // Parse basic item info
        let name = '';
        let type = '';
        let rarity = '';
        
        // Try to find name (first line)
        if (buffer.length > 0) {
          const firstLine = buffer[0];
          const rarityMatch = firstLine.match(new RegExp(`\\b(${rarityKeywords.join('|')})\\b`, 'i'));
          const typeMatch = firstLine.match(new RegExp(`\\b(${itemTypeKeywords.join('|')})\\b`, 'i'));
          
          if (rarityMatch) rarity = rarityMatch[1];
          if (typeMatch) type = typeMatch[1];
          
          // Name is everything before rarity/type
          name = firstLine.split(/(?:common|uncommon|rare|very rare|legendary|artifact|weapon|armor|wondrous item|potion|scroll|ring|wand|staff|rod)/i)[0].trim();
        }
        
        extractedItems.push({
          rawText: itemText,
          parsed: {
            name: name || 'Unknown Item',
            type: type || 'Wondrous Item',
            rarity: rarity || 'Common',
            description: itemText
          }
        });
        
        foundItemStart = false;
        buffer = [];
      }
    }
  }
  
  // Deduplicate by name, keeping the first one
  const seenNames = new Set();
  const uniqueItems = [];
  for (const item of extractedItems) {
    const name = item.parsed?.name || '';
    if (name && !seenNames.has(name.toLowerCase())) {
      seenNames.add(name.toLowerCase());
      uniqueItems.push(item);
    }
  }
  
  console.log(`extractItemsFromPDFText: Found ${extractedItems.length} total, unique: ${uniqueItems.length}`);
  return uniqueItems;
}

function saveExtractedItemsToGlobal(items) {
  try {
    const existing = JSON.parse(localStorage.getItem('dnd_extension_extracted_items') || '[]');
    
    // Deduplicate: keep only new items not already in existing
    const seenNames = new Set(existing.map(i => i.parsed?.name?.toLowerCase() || ''));
    const newItems = items.filter(i => {
      const name = i.parsed?.name?.toLowerCase() || '';
      if (name && !seenNames.has(name)) {
        seenNames.add(name);
        return true;
      }
      return false;
    });
    
    const all = [...existing, ...newItems];
    localStorage.setItem('dnd_extension_extracted_items', JSON.stringify(all));
    return newItems.length;
  } catch (e) {
    console.error('Failed to save extracted items:', e);
    return 0;
  }
}

// Custom Data Helpers
function getCustomMonsters() {
    try { return JSON.parse(localStorage.getItem('dnd_extension_custom_monsters') || '[]'); } catch (e) { return []; }
}
function restoreItem(name) {
     try {
         let list = JSON.parse(localStorage.getItem('dnd_extension_deleted_items') || '[]');
         const idx = list.indexOf(name);
         if (idx !== -1) {
             list.splice(idx, 1);
             localStorage.setItem('dnd_extension_deleted_items', JSON.stringify(list));
             saveToBackend();
         }
     } catch (e) { }
}
// Backend Sync Logic
const API_BASE = '/api';

function getDeletedItems() {
    try { return JSON.parse(localStorage.getItem('dnd_extension_deleted_items') || '[]'); } catch (e) { return []; }
}

async function syncWithBackend() {
    try {
        const res = await fetch(`${API_BASE}/health`);
        if (!res.ok) return; 

        const dataRes = await fetch(`${API_BASE}/data`);
        const data = await dataRes.json();
        
        const localMonsters = getCustomMonsters();
        const localItems = getCustomItems();
        const localDeleted = getDeletedItems();
        let changed = false;

        if (data.monsters && Array.isArray(data.monsters)) {
            data.monsters.forEach(m => {
                const idx = localMonsters.findIndex(lm => lm.name === m.name);
                if (idx === -1) { localMonsters.push(m); changed = true; }
                else if (JSON.stringify(localMonsters[idx]) !== JSON.stringify(m)) { localMonsters[idx] = m; changed = true; }
            });
            if (changed) localStorage.setItem('dnd_extension_custom_monsters', JSON.stringify(localMonsters));
        }
        
        if (data.items && Array.isArray(data.items)) {
            data.items.forEach(i => {
                const idx = localItems.findIndex(li => li.name === i.name);
                if (idx === -1) { localItems.push(i); changed = true; }
                else if (JSON.stringify(localItems[idx]) !== JSON.stringify(i)) { localItems[idx] = i; changed = true; }
            });
            if (changed) localStorage.setItem('dnd_extension_custom_items', JSON.stringify(localItems));
        }

        if (data.deleted && Array.isArray(data.deleted)) {
            data.deleted.forEach(d => {
                if (!localDeleted.includes(d)) { localDeleted.push(d); changed = true; }
            });
            if (changed) localStorage.setItem('dnd_extension_deleted_items', JSON.stringify(localDeleted));
        }

        if (data.images && typeof data.images === 'object') {
            for (const [key, val] of Object.entries(data.images)) {
                if (localStorage.getItem(key) !== val) {
                    localStorage.setItem(key, val);
                    changed = true;
                }
            }
        }
        
        if (changed) {
            console.log('Synced with backend');
            // Force re-render if we are in the search view
            const searchView = document.getElementById('search-view');
            if (searchView && searchView.style.display !== 'none') {
                const searchInput = document.getElementById('search-input');
                if (searchInput) {
                    renderResults(searchInput.value);
                }
            }
        }
    } catch (e) {
        console.warn("Backend sync failed (ignore if offline/static):", e);
    }
}

async function saveToBackend() {
    try {
        const monsters = getCustomMonsters();
        const items = getCustomItems();
        const spells = getCustomSpells();
        const deleted = getDeletedItems();
        
        // Collect images from localStorage
        const images = {};
        const imagesData = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && (key.startsWith('monster_image_') || key.startsWith('item_image_') || key.startsWith('spell_image_'))) {
                images[key] = localStorage.getItem(key);
            }
            // Backup raw data for persistence
            if (key && (key.startsWith('monster_image_') || key.startsWith('item_image_') || key.startsWith('spell_image_')) && key.endsWith('_data')) {
                imagesData[key.replace('_data', '')] = localStorage.getItem(key);
            }
        }

        await fetch(`${API_BASE}/data`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ monsters, items, spells, deleted, images, imagesData })
        });
    } catch (e) {
        // Silent fail
    }
}

function saveCustomMonster(monster) {
    try {
        const list = getCustomMonsters();
        const index = list.findIndex(m => m.name === monster.name);
        if (index >= 0) list[index] = monster;
        else list.push(monster);
        localStorage.setItem('dnd_extension_custom_monsters', JSON.stringify(list));
        saveToBackend(); // Sync to backend
        restoreItem(monster.name);
        return true;
    } catch (e) {
        console.error("Failed to save custom monster:", e);
        if (e.name === 'QuotaExceededError' || e.message.includes('quota')) {
            alert("Storage Full! Cannot save monster data. Please delete some custom images or items to free up space.");
        } else {
            alert("Failed to save monster data: " + e.message);
        }
        return false;
    }
}
function getCustomItems() {
    try { return JSON.parse(localStorage.getItem('dnd_extension_custom_items') || '[]'); } catch (e) { return []; }
}
function saveCustomItem(item) {
    try {
        const list = getCustomItems();
        const index = list.findIndex(i => i.name === item.name);
        if (index >= 0) list[index] = item;
        else list.push(item);
        localStorage.setItem('dnd_extension_custom_items', JSON.stringify(list));
        saveToBackend();
        restoreItem(item.name);
        return true;
    } catch (e) {
        console.error("Failed to save custom item:", e);
        if (e.name === 'QuotaExceededError' || e.message.includes('quota')) {
            alert("Storage Full! Cannot save item data. Please delete some custom images or items to free up space.");
        } else {
            alert("Failed to save item data: " + e.message);
        }
        return false;
    }
}

function getCustomSpells() {
    try { return JSON.parse(localStorage.getItem('dnd_extension_custom_spells') || '[]'); } catch (e) { return []; }
}

function saveCustomSpell(spell) {
    try {
        const list = getCustomSpells();
        const index = list.findIndex(s => s.name === spell.name);
        if (index >= 0) list[index] = spell;
        else list.push(spell);
        localStorage.setItem('dnd_extension_custom_spells', JSON.stringify(list));
        saveToBackend();
        restoreItem(spell.name);
        return true;
    } catch (e) {
        console.error("Failed to save custom spell:", e);
        if (e.name === 'QuotaExceededError' || e.message.includes('quota')) {
            alert("Storage Full! Cannot save spell data. Please delete some custom images or items to free up space.");
        } else {
            alert("Failed to save spell data: " + e.message);
        }
        return false;
    }
}

export function searchSpells(query) {
  const deleted = getDeletedItems();
  const customs = getCustomSpells();
  
  // Merge built-in SPELL_DATA with custom spells
  // SPELL_DATA is an object { name: details }, so we convert to array
  const builtInSpells = Object.entries(SPELL_DATA).map(([name, data]) => ({ name, ...data }));
  
  // Filter out built-ins overridden by customs
  const activeBuiltIns = builtInSpells.filter(s => !customs.some(c => c.name === s.name));
  
  const allSpells = activeBuiltIns.filter(s => !deleted.includes(s.name));
  
  if (!query) return allSpells.slice(0, 50);
  
  const lowerQuery = query.toLowerCase();
  return allSpells.filter(s => 
      s.name.toLowerCase().includes(lowerQuery) ||
      (s.description && s.description.toLowerCase().includes(lowerQuery))
  ).slice(0, 50);
}

export function searchMonsters(query, searchNameOnly = false, minCrStr = '', maxCrStr = '') {
  const deleted = getDeletedItems();
  const customs = getCustomMonsters();
  // Filter out built-ins that are overridden by customs
  const builtIns = monsters.filter(m => !customs.some(c => c.name === m.name));
  const allMonsters = builtIns.filter(m => !deleted.includes(m.name));

  // Return everything (first 50) if no filters active
  if (!query && !minCrStr && !maxCrStr) return allMonsters.slice(0, 50);

  const lowerQuery = query ? query.toLowerCase() : '';
  const minCr = minCrStr !== '' ? parseCR(minCrStr) : -1;
  const maxCr = maxCrStr !== '' ? parseCR(maxCrStr) : 999;

  return allMonsters.filter(m => {
    // 1. Text Search
    let matchesText = true;
    if (query) {
        const nameMatch = m.name.toLowerCase().includes(lowerQuery);
        if (searchNameOnly) {
            matchesText = nameMatch;
        } else {
            matchesText = nameMatch || (m.description && m.description.toLowerCase().includes(lowerQuery));
        }
    }

    // 2. CR Range Filter
    let matchesCr = true;
    if (minCr !== -1 || maxCr !== 999) {
        const mCr = parseCR(m.cr);
        if (mCr < minCr || mCr > maxCr) {
            matchesCr = false;
        }
    }

    return matchesText && matchesCr;
  }).slice(0, 50); // Limit to 50 results for performance
}

// Helper: Compress Data URI if too large
function compressImage(dataUri, quality = 0.8, maxWidth = 1000) {
    return new Promise((resolve) => {
        // Only compress if it's a Data URI
        if (!dataUri || !dataUri.startsWith('data:image')) {
            resolve(dataUri);
            return;
        }

        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            let w = img.width;
            let h = img.height;
            
            // Resize if too big
            if (w > maxWidth) {
                h = Math.round(h * (maxWidth / w));
                w = maxWidth;
            }
            
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            
            // Convert to JPEG for better compression (unless it was SVG/WebP, but JPEG is safest for size)
            // If original was PNG with transparency, JPEG turns it black. 
            // Better to use 'image/webp' if supported, or stick to 'image/png' but resized.
            // Let's try WebP first, fallback to PNG
            let newUrl = canvas.toDataURL('image/webp', quality);
            if (newUrl.length < dataUri.length) {
                resolve(newUrl);
            } else {
                 // Try PNG with resizing only
                 newUrl = canvas.toDataURL('image/png');
                 resolve(newUrl.length < dataUri.length ? newUrl : dataUri);
            }
        };
        img.onerror = () => resolve(dataUri);
        img.src = dataUri;
    });
}

// Helper: Get Stored Image with Case-Insensitive Fallback
function getStoredImage(mode, name) {
    const prefix = mode === 'monster' ? 'monster_image_' : (mode === 'spell' ? 'spell_image_' : 'item_image_');
    
    // Helper to validate retrieved value
    const validate = (val) => {
        if (!val) return null;
        if (typeof val !== 'string') return null;
        if (val === 'null' || val === 'undefined') return null;
        // Check for JSON-like content (likely corruption or bad paste)
        if (val.trim().startsWith('{') || val.trim().startsWith('%7B')) return null;
        return val;
    };

    // 1. Exact match
    let val = validate(localStorage.getItem(prefix + name));
    if (val) return val;
    
    // 2. Lowercase match
    val = validate(localStorage.getItem(prefix + name.toLowerCase()));
    if (val) return val;
    
    // 3. Title Case match (simple)
    const titleCase = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
    val = validate(localStorage.getItem(prefix + titleCase));
    if (val) return val;
    
    // 4. Uppercase match
    val = validate(localStorage.getItem(prefix + name.toUpperCase()));
    if (val) return val;
    
    return null;
}

// Helper: Get used images for a specific entry (for picker)
function getUsedImagesForEntry(entryName) {
    if (!entryName) return [];
    try {
        const stored = localStorage.getItem(`dnd_extension_entry_images_${entryName}`);
        return stored ? JSON.parse(stored) : [];
    } catch (e) {
        return [];
    }
}

// Helper: Add a used image to an entry's history (if not already present)
function addUsedImageForEntry(entryName, url) {
    if (!entryName || !url) return;
    const used = getUsedImagesForEntry(entryName);
    if (!used.includes(url)) {
        used.unshift(url); // Add to front
        // Keep only last 20 images per entry
        if (used.length > 20) {
            used.pop();
        }
        localStorage.setItem(`dnd_extension_entry_images_${entryName}`, JSON.stringify(used));
    }
}

// Helper to ensure image URL is within OBR limits (2048 chars) by uploading Base64 to local server if needed
async function ensureShortImageUrl(url, name = null, folder = null) {
    if (!url) return url;
    if (typeof url !== 'string') return null;
    
    // Basic cleanup
    url = url.trim();
    
    // Check for invalid content (JSON objects)
    if (url.startsWith('{') || url.startsWith('%7B')) {
        console.warn("Invalid Image URL detected (JSON object). Discarding.");
        return null;
    }

    // Remove whitespace from Data URIs (newlines/spaces can break fetch/OBR)
    if (url.startsWith('data:')) {
        url = url.replace(/\s/g, '');
    }

    // Attempt to compress if it's a large Data URI (> 200KB)
    if (url.startsWith('data:image') && url.length > 200000) {
        console.log("Image is large (" + Math.round(url.length/1024) + "KB), attempting to compress...");
        try {
            // Try simpler compression (lower quality)
            const compressed = await compressImage(url, 0.6);
            if (compressed.length < url.length) {
                console.log("Compressed to " + Math.round(compressed.length/1024) + "KB");
                url = compressed;
            }
        } catch (e) {
            console.warn("Compression failed:", e);
        }
    }

    // If it's a Data URI, persist the raw data locally and use a stable, short server URL.
    // This avoids relying on ephemeral filesystem storage on hosts that restart.
    if (url.startsWith('data:image')) {
        // Determine storage key based on folder/name
        const prefix = folder === 'items' ? 'item_image_' : (folder === 'spells' ? 'spell_image_' : 'monster_image_');
        const key = `${prefix}${name}`;
        try {
            localStorage.setItem(`${key}_data`, url);
        } catch (e) {
            console.warn("Failed to store image data locally:", e);
        }
        // Return a short, stable URL that the server will serve from DB
        const staticUrl = `/api/static-image?key=${encodeURIComponent(key)}`;
        const absoluteUrl = new URL(staticUrl, window.location.href).href;
        return absoluteUrl;
    }
    return url;
}

// Helper to generate a dynamic placeholder image (SVG Data URI)
function getPlaceholderImage(name, type = 'monster') {
    const letter = name ? name.charAt(0).toUpperCase() : '?';
    const color1 = type === 'monster' ? '#ff6b6b' : '#4a235a'; // Red for monsters, Purple for items
    const color2 = type === 'monster' ? '#8b0000' : '#1a1025';

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <radialGradient id="grad1" cx="50%" cy="50%" r="50%" fx="50%" fy="50%">
      <stop offset="0%" style="stop-color:${color1};stop-opacity:1" />
      <stop offset="100%" style="stop-color:${color2};stop-opacity:1" />
    </radialGradient>
  </defs>
  <circle cx="256" cy="256" r="250" fill="url(#grad1)" />
  <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="250" fill="white" font-family="Arial">${letter}</text>
</svg>`;
    return "data:image/svg+xml;base64," + btoa(svg);
}

export async function addMonsterToScene(monster) {
  // Ensure we have a valid image URL (check localStorage first, then fallback)
  // Use getStoredImage for case-insensitive lookup
  let imageUrl = getStoredImage('monster', monster.name) || monster.image;
  
  // Upgrade HTTP to HTTPS to avoid mixed content warnings
  if (imageUrl && typeof imageUrl === 'string' && imageUrl.startsWith('http://')) {
      imageUrl = 'https://' + imageUrl.substring('http://'.length);
  }
  
  // Robust validation: If it's not a string or looks like JSON, discard it
  if (imageUrl && (typeof imageUrl !== 'string' || imageUrl.trim().startsWith('{') || imageUrl.trim().startsWith('%7B'))) {
      console.warn("Invalid/Corrupt monster image URL detected. Resetting to default.");
      imageUrl = null;
  }
  
  // Helper to check if image exists with a timeout to avoid hanging
  const checkImage = (url, timeout = 500) => new Promise(resolve => {
      const img = new Image();
      let resolved = false;
      const timer = setTimeout(() => {
          if (!resolved) {
              resolved = true;
              resolve(false);
          }
      }, timeout);
      
      img.onload = () => {
          if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              resolve(true);
          }
      };
      img.onerror = () => {
          if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              resolve(false);
          }
      };
      img.src = url;
  });

  // Validate the initial image URL. If it fails, clear it to trigger fallback search.
  if (imageUrl) {
      // Resolve relative path first
      if (!imageUrl.startsWith('http') && !imageUrl.startsWith('data:')) {
          try {
              imageUrl = new URL(imageUrl, window.location.href).href;
          } catch (e) {}
      }
      
      const exists = await checkImage(imageUrl, 500);
      if (!exists) {
          console.warn(`Image URL failed to load: ${imageUrl}. Using placeholder.`);
          imageUrl = null; // Skip all the fallback checks, go straight to placeholder
      }
  }

  // If no image found, use placeholder immediately
  if (!imageUrl) {
      imageUrl = getPlaceholderImage(monster.name, 'monster');
  }
  
  // Ensure URL is short enough for OBR (upload if necessary)
  // Since we are spawning a monster, if we upload, store it in 'monsters' folder with the monster name
  imageUrl = await ensureShortImageUrl(imageUrl, monster.name, 'monsters');

  console.log(`[v${EXTENSION_VERSION}] Resolved imageUrl for ${monster.name}:`, imageUrl);

  console.log(`[v${EXTENSION_VERSION}] Preparing to add monster:`, monster.name);

  // Determine size based on type (default to Medium/150px)
  let size = 150;
  if (monster.type) {
      const lowerType = monster.type.toLowerCase();
      if (lowerType.includes('gargantuan')) size = 600; // 4x4
      else if (lowerType.includes('huge')) size = 450; // 3x3
      else if (lowerType.includes('large')) size = 300; // 2x2
      else if (lowerType.includes('small') || lowerType.includes('tiny')) size = 150; // 1x1 (Small/Tiny control 5ft)
  }
  
  // Ensure size is an integer
  size = Math.floor(size);

  console.log(`Calculated size for ${monster.name}: ${size}px (Type: ${monster.type})`);

  // Detect MIME type from the image URL
  let mimeType = 'image/png';
  if (imageUrl.startsWith('data:image/jpeg')) {
      mimeType = 'image/jpeg';
  } else if (imageUrl.startsWith('data:image/webp')) {
      mimeType = 'image/webp';
  } else if (imageUrl.startsWith('data:image/gif')) {
      mimeType = 'image/gif';
  } else if (imageUrl.startsWith('data:image/svg+xml')) {
      mimeType = 'image/svg+xml';
  } else if (imageUrl.match(/\.(jpeg|jpg)($|\?)/i)) {
      mimeType = 'image/jpeg';
  } else if (imageUrl.match(/\.webp($|\?)/i)) {
      mimeType = 'image/webp';
  } else if (imageUrl.match(/\.gif($|\?)/i)) {
      mimeType = 'image/gif';
  } else if (imageUrl.match(/\.svg(\+xml)?($|\?)/i)) {
      mimeType = 'image/svg+xml';
  }
  
  console.log(`Building image for ${monster.name} with mime: ${mimeType}`);

  // Calculate Dimensions and DPI for correct scaling
  let finalWidth = size;
  let finalHeight = size;
  let finalDpi = 150;
  
  try {
      // Pre-load image to get dimensions
      const img = new Image();
      img.src = imageUrl;
      await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => {
              console.warn("Failed to load image for dimension calculation, using default square size.");
              resolve(); 
          };
          setTimeout(() => resolve(), 1000);
      });

      if (img.width && img.height) {
          // Use actual image dimensions
          finalWidth = img.width;
          finalHeight = img.height;
          
          // Calculate DPI to fit the image within the target size (in grid squares)
          // size is 150 (1 sq), 300 (2 sq), etc.
          // OBR standard grid is 150px per square
          const targetSquares = size / 150;
          const maxSide = Math.max(finalWidth, finalHeight);
          
          // dpi = pixels / squares
          finalDpi = maxSide / targetSquares;
          
          console.log(`Calculated DPI: ${finalDpi} for image ${finalWidth}x${finalHeight} to fit in ${targetSquares} squares.`);
      }
  } catch (e) {
      console.warn("Error calculating dimensions:", e);
  }

  // Skip local validation and let OBR handle it

  // Wrap in OBR.onReady to ensure SDK is ready
  if (window.self !== window.top) {
      // Production mode
      await new Promise((resolve, reject) => {
           OBR.onReady(async () => {
               try {
                   // Robust stat parsing
                   const parseStat = (val) => {
                       if (typeof val === 'number') return val;
                       if (typeof val === 'string') {
                           const match = val.match(/^(\d+)/);
                           return match ? parseInt(match[1]) : 10;
                       }
                       return 10;
                   };
                   
                   const hpValue = parseStat(monster.hp);
                   const acValue = parseStat(monster.ac);

                   // Determine Position
                   let pos = { x: 0, y: 0 };
                   console.log("addMonsterToScene using spawnPosition:", spawnPosition);
                   if (spawnPosition) {
                       pos = { ...spawnPosition };
                   } else {
                        try {
                            const center = await OBR.viewport.getPosition();
                            pos = { x: center.x, y: center.y };
                        } catch (vpErr) {
                            console.warn("Could not get viewport position:", vpErr);
                        }
                    }
                   
                   const hideName = localStorage.getItem('dnd_extension_hide_name') === 'true';
                   const hideHP = localStorage.getItem('dnd_extension_hide_hp') === 'true';
                   const hideAC = localStorage.getItem('dnd_extension_hide_ac') === 'true';
                   const hideCR = localStorage.getItem('dnd_extension_hide_cr') === 'true';

                   let label = "";
                   if (!hideName) label += monster.name;
                   
                   let statsLine = "";
                   if (!hideHP) statsLine += `HP: ${hpValue}`;
                   if (!hideHP && !hideAC) statsLine += " ";
                   if (!hideAC) statsLine += `AC: ${acValue}`;
                   if ((!hideHP || !hideAC) && !hideCR && monster.cr !== undefined) statsLine += " ";
                   if (!hideCR && monster.cr !== undefined) statsLine += `CR: ${monster.cr}`;
                   
                   if (statsLine) {
                       if (label) label += "\n";
                       label += statsLine;
                   }

                   const item = buildImage(
                     {
                         url: imageUrl,
                         mime: mimeType,
                         width: finalWidth,
                         height: finalHeight,
                     }
                   )
                     .position(pos)
                     .scale({ x: 1, y: 1 })
                     .plainText(label)
                     .metadata({
                         name: monster.name,
                         hp: hpValue,
                         ac: acValue,
                         cr: String(monster.cr || "Unknown"),
                         description: String(monster.description || ""),
                         source: String(monster.source || ""),
                         created_by: "dnd_extension"
                     })
                     .layer('CHARACTER')
                     .locked(false)
                     .disableHit(false)
                     .build();

                   // Explicitly set grid property (Required by OBR for Image items)
                   item.grid = { dpi: finalDpi, offset: { x: 0, y: 0 } };


                   console.log("Adding item to scene:", item);

                   OBR.scene.items.addItems([item])
                     .then(() => {
                         console.log(`Successfully added ${monster.name} to scene with metadata.`);
                         resolve(item);
                     })
                     .catch((err) => {
                         console.error("OBR addItems failed:", err);
                         // Alert the full item structure for debugging
                         if (err.name === 'ValidationError') {
                             alert(`Validation Error: ${err.message}\nCheck console for item details.`);
                             console.error("Failed Item JSON:", JSON.stringify(item, null, 2));
                         }
                         
                         // If still not ready, retry once after a short delay
                         if (err && err.message && err.message.includes("not ready")) {
                             console.warn("OBR reported 'not ready' on addItems. Retrying in 200ms...");
                             setTimeout(() => {
                                 OBR.scene.items.addItems([item])
                                    .then(() => resolve(item))
                                    .catch(reject);
                             }, 200);
                         } else {
                             reject(err);
                         }
                     });
               } catch (buildError) {
                   reject(buildError);
               }
           });
      });
  } else {
      // Standalone/Mock mode
      // Manual object creation for standalone since buildImage might fail without OBR context
      const item = {
        id: `monster-${Date.now()}`,
        type: 'IMAGE',
        position: { x: 0, y: 0 },
        width: size,
        height: size,
        image: { url: imageUrl, mime: mimeType },
        text: { plainText: monster.name },
        metadata: {
            hp: monster.hp,
            ac: monster.ac,
            cr: monster.cr || "Unknown",
            description: monster.description,
            source: monster.source,
            created_by: "dnd_extension"
        },
        layer: 'CHARACTER'
      };
      
      await OBR.scene.items.addItems([item]);
      return item;
  }
}

  // Helper: Add Item to Scene
  export async function addItemToScene(itemData) {
      console.log(`[v${EXTENSION_VERSION}] Preparing to add item:`, itemData.name);
      
      // Default Icon: A generic satchel/bag
      const defaultIcon = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj48cGF0aCBmaWxsPSIjRkZEMzAwIiBkPSJNMTI4IDE3NnYtNDhjMC0yNi41IDIxLjUtNDggNDgtNDhoMTYwYzI2LjUgMCA0OCAyMS41IDQ4IDQ4djQ4aDU2djMySDcydi0zMmg1NnptODAgMHYtNDhoOTZ2NDhIMjA4em0tODAgODAwdjE5MmMwIDE3LjcgMTQuMyAzMiAzMiAzMmgxOTJjMTcuNyAwIDMyLTE0LjMgMzItMzJWMjU2SDEyOHoiLz48L3N2Zz4=";
      
      const itemTypeImages = {
          'sword': 'images/items/sword.svg',
          'greatsword': 'images/items/sword.svg',
          'longsword': 'images/items/sword.svg',
          'scimitar': 'images/items/sword.svg',
          'rapier': 'images/items/sword.svg',
          'staff': 'images/items/staff.svg',
          'book': 'images/items/book.svg',
          'tome': 'images/items/book.svg',
          'manual': 'images/items/book.svg',
          'wand': 'images/items/wand.svg',
          'boot': 'images/items/boots.svg',
          'shoe': 'images/items/boots.svg',
          'shield': 'images/items/shield.svg',
          'armor': 'images/items/armor.svg',
          'plate': 'images/items/armor.svg',
          'mail': 'images/items/armor.svg',
          'leather': 'images/items/armor.svg',
          'hide': 'images/items/armor.svg',
          'ring': 'images/items/ring.svg',
          'rod': 'images/items/rod.svg',
          'bow': 'images/items/bow.svg',
          'crossbow': 'images/items/bow.svg',
          'dagger': 'images/items/dagger.svg',
          'axe': 'images/items/axe.svg',
          'hammer': 'images/items/hammer.svg',
          'mace': 'images/items/hammer.svg',
          'flail': 'images/items/hammer.svg',
          'potion': 'images/items/potion.svg',
          'oil': 'images/items/potion.svg',
          'elixir': 'images/items/potion.svg',
          'scroll': 'images/items/scroll.svg',
          'wondrous': 'images/items/generic.svg',
          'glove': 'images/items/generic.svg',
          'gauntlet': 'images/items/generic.svg',
          'belt': 'images/items/generic.svg',
          'cloak': 'images/items/generic.svg',
          'amulet': 'images/items/generic.svg',
          'necklace': 'images/items/generic.svg',
          'circlet': 'images/items/generic.svg',
          'gem': 'images/items/generic.svg',
          'jewel': 'images/items/generic.svg'
      };

      // Resolve image: Check storage first, then item.image
      let imageUrl = getStoredImage('item', itemData.name) || itemData.image;

      // Robust validation
      if (imageUrl && (typeof imageUrl !== 'string' || imageUrl.trim().startsWith('{') || imageUrl.trim().startsWith('%7B'))) {
          console.warn("Invalid/Corrupt item image URL detected. Resetting to default.");
          imageUrl = null;
      }
       
       // Detect 404 placeholder (Base64 for "Not Found" is Tm90IEZvdW5k)
       const isPlaceholder = imageUrl && imageUrl.startsWith('data:') && imageUrl.includes('Tm90IEZvdW5k');

       if ((!imageUrl || isPlaceholder)) {
           let found = false;
           // 1. Try Type
           if (itemData.type) {
               const lowerType = itemData.type.toLowerCase();
               for (const [key, value] of Object.entries(itemTypeImages)) {
                   if (lowerType.includes(key)) {
                       imageUrl = value;
                       found = true;
                       break;
                   }
               }
           }
           
           // 2. Try Name if not found
           if (!found && itemData.name) {
               const lowerName = itemData.name.toLowerCase();
               for (const [key, value] of Object.entries(itemTypeImages)) {
                   if (lowerName.includes(key)) {
                       imageUrl = value;
                       found = true;
                       break;
                   }
               }
           }
       }
       
       if (!imageUrl || (isPlaceholder && imageUrl.includes('Tm90IEZvdW5k'))) imageUrl = defaultIcon;

      // Resolve relative paths (e.g. from extracted images)
      if (imageUrl && !imageUrl.startsWith('http') && !imageUrl.startsWith('data:')) {
          try {
              imageUrl = new URL(imageUrl, window.location.href).href;
          } catch (e) {
              console.warn("Failed to resolve relative image URL:", imageUrl, e);
          }
      }

      // Ensure URL is short enough for OBR
      imageUrl = await ensureShortImageUrl(imageUrl, itemData.name, 'items');

      // Detect MIME
      let mimeType = 'image/svg+xml';
      if (imageUrl.startsWith('data:image/jpeg') || imageUrl.match(/\.(jpeg|jpg)$/i)) mimeType = 'image/jpeg';
      else if (imageUrl.startsWith('data:image/png') || imageUrl.match(/\.png$/i)) mimeType = 'image/png';
      else if (imageUrl.startsWith('data:image/webp') || imageUrl.match(/\.webp$/i)) mimeType = 'image/webp';
      
      // Size: Items are usually small/medium (150px)
      let finalWidth = 150;
      let finalHeight = 150;
      let finalDpi = 150;

      // Attempt to get real dimensions to fix "warnIncorrectSize"
      try {
          const dims = await getImageDimensions(imageUrl);
          if (dims && dims.width && dims.height) {
              finalWidth = dims.width;
              finalHeight = dims.height;
              
              // Calculate DPI to fit the item into 1 grid square (150 logical pixels)
              const maxSide = Math.max(finalWidth, finalHeight);
              finalDpi = maxSide; 
          }
      } catch (e) {
          console.warn("Could not get image dimensions, using defaults", e);
      }
      
      await new Promise((resolve, reject) => {
           OBR.onReady(() => {
               try {
                   const hideName = localStorage.getItem('dnd_extension_hide_name') === 'true';
                   let label = "";
                   if (!hideName) label += itemData.name;
                   if (itemData.type) {
                       if (label) label += "\n";
                       label += itemData.type;
                   } else if (!label) {
                       label = "Item";
                   }

                   const item = buildImage(
                     {
                         url: imageUrl,
                         mime: mimeType,
                         width: finalWidth,
                         height: finalHeight,
                     }
                   )
                     .position({ x: 0, y: 0 })
                     .scale({ x: 1, y: 1 })
                     .plainText(label)
                     .metadata({
                         name: itemData.name,
                         type: itemData.type,
                         rarity: itemData.rarity,
                         description: String(itemData.description || ""),
                         source: String(itemData.source || ""),
                         created_by: "dnd_extension_item"
                     })
                     .layer('PROP') // Items are props, usually
                     .locked(false)
                     .disableHit(false)
                     .build();

                   // Set Grid DPI
                   item.grid = { dpi: finalDpi, offset: { x: 0, y: 0 } };

                   OBR.scene.items.addItems([item])
                     .then(() => {
                         console.log(`Successfully added item ${itemData.name}`);
                         OBR.notification.show(`Added ${itemData.name} to map`);
                         resolve(item);
                     })
                     .catch((err) => {
                         console.error("Failed to add item:", err);
                         reject(err);
                     });
               } catch (e) {
                   reject(e);
               }
           });
      });
  }


// Helper: Process Image and Remove Background
function processAndRemoveBackground(source) {
    return new Promise((resolve, reject) => {
        // Strategy: 0=Direct, 1=corsproxy.io, 2=allorigins.win
        const tryLoadImage = (url, attemptLevel = 0) => {
            const img = new Image();
            img.crossOrigin = "Anonymous";
            
            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    let width = img.width;
                    let height = img.height;
                    const maxWidth = 300; // Constrain size

                    if (width > maxWidth) {
                        height = Math.round((height * maxWidth) / width);
                        width = maxWidth;
                    }
                    if (height > maxWidth) {
                        width = Math.round((width * maxWidth) / height);
                        height = maxWidth;
                    }

                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);

                    const imageData = ctx.getImageData(0, 0, width, height);
                    const data = imageData.data;
                    const w = width;
                    const h = height;

                    // --- Improved Background Removal Logic ---
                    // Strategy: Scan all 4 edges to determine the background color.
                    let edgePixels = [];
                    const addEdgeSample = (x, y) => {
                        const idx = (y * w + x) * 4;
                        edgePixels.push({
                            r: data[idx], g: data[idx+1], b: data[idx+2], a: data[idx+3],
                            idx: idx
                        });
                    };

                    // Sample Top & Bottom rows
                    for (let x = 0; x < w; x++) { addEdgeSample(x, 0); addEdgeSample(x, h-1); }
                    // Sample Left & Right columns
                    for (let y = 1; y < h-1; y++) { addEdgeSample(0, y); addEdgeSample(w-1, y); }

                    let whiteCount = 0;
                    let blackCount = 0;
                    let transparentCount = 0;
                    let avgR = 0, avgG = 0, avgB = 0;
                    let totalSamples = edgePixels.length;

                    for (const p of edgePixels) {
                        if (p.a < 50) {
                            transparentCount++;
                            continue;
                        }
                        // Relaxed threshold for white (e.g. compression artifacts)
                        if (p.r > 200 && p.g > 200 && p.b > 200) {
                            whiteCount++;
                            avgR += p.r; avgG += p.g; avgB += p.b;
                        } else if (p.r < 50 && p.g < 50 && p.b < 50) {
                            blackCount++;
                        }
                    }

                    let targetMode = null;
                    const whiteThreshold = totalSamples * 0.4; // If 40% of border is white, treat as white bg
                    const blackThreshold = totalSamples * 0.4;

                    if (transparentCount > totalSamples * 0.9) {
                        // Already transparent, skip
                        console.log("Image border is already transparent. Skipping removal.");
                    } else if (whiteCount > whiteThreshold) {
                        targetMode = 'white';
                        // Use the average of the white pixels as the reference color
                        avgR = Math.round(avgR / whiteCount);
                        avgG = Math.round(avgG / whiteCount);
                        avgB = Math.round(avgB / whiteCount);
                    } else if (blackCount > blackThreshold) {
                        targetMode = 'black';
                        avgR = 0; avgG = 0; avgB = 0; // Assume pure black for black mode
                    }

                    if (targetMode) {
                        console.log(`Detected ${targetMode} background. AvgColor: ${avgR},${avgG},${avgB}. Starting removal...`);
                        
                        // Use stricter tolerance for white mode to prevent erasing white monsters (e.g., Unicorns)
                        let tolerance = 60; 
                        if (targetMode === 'white') {
                            tolerance = 50; // Moderate tolerance (was 30, which was too strict for artifacts)
                        }

                        const queue = [];
                        const visited = new Uint8Array(w * h);
                        
                        // Seed the queue with all border pixels that match the target color
                        const checkAndSeed = (x, y) => {
                            const idx = y * w + x;
                            if (visited[idx]) return;

                            const i = idx * 4;
                            const r = data[i];
                            const g = data[i+1];
                            const b = data[i+2];
                            const a = data[i+3];

                            if (a < 50) return; // Already transparent

                            const dist = Math.abs(r - avgR) + Math.abs(g - avgG) + Math.abs(b - avgB);
                            
                            // Seed Check: Allow slightly noisier borders to start the flood fill
                            if (dist < tolerance * 1.5) {
                                queue.push(idx);
                                visited[idx] = 1;
                            }
                        };

                        // Scan edges again to seed
                        for (let x = 0; x < w; x++) { checkAndSeed(x, 0); checkAndSeed(x, h-1); }
                        for (let y = 1; y < h-1; y++) { checkAndSeed(0, y); checkAndSeed(w-1, y); }

                        while (queue.length > 0) {
                            const idx = queue.shift();
                            const x = idx % w;
                            const y = Math.floor(idx / w);
                            const i = idx * 4;

                            data[i+3] = 0; // Make transparent

                            const neighbors = [
                                {nx: x+1, ny: y}, {nx: x-1, ny: y},
                                {nx: x, ny: y+1}, {nx: x, ny: y-1}
                            ];

                            for (const {nx, ny} of neighbors) {
                                if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                                    const nIdx = ny * w + nx;
                                    if (!visited[nIdx]) {
                                        const ni = nIdx * 4;
                                        const nr = data[ni];
                                        const ng = data[ni+1];
                                        const nb = data[ni+2];
                                        
                                        const dist = Math.abs(nr - avgR) + Math.abs(ng - avgG) + Math.abs(nb - avgB);
                                        
                                        // Use balanced multiplier for white
                                        // 2.0 gives MaxDist = 50 * 2.0 = 100 (Covers light grays/artifacts)
                                        // 3.0 gives MaxDist = 60 * 3.0 = 180 (Covers almost everything light)
                                        const fillMultiplier = targetMode === 'white' ? 2.0 : 3.0;
                                        
                                        if (dist < tolerance * fillMultiplier) {
                                            visited[nIdx] = 1;
                                            queue.push(nIdx);
                                        }
                                    }
                                }
                            }
                        }
                        ctx.putImageData(imageData, 0, 0);
                        console.log(`Removed ${targetMode} background via attempt ${attemptLevel}`);
                    } else {
                        console.log("No uniform background detected on borders. Skipping.");
                    }

                    
                    resolve(canvas.toDataURL('image/png'));
                } catch (e) {
                    console.warn(`Attempt ${attemptLevel} canvas processing failed (likely CORS taint):`, e);
                    if (attemptLevel < 2) {
                        nextAttempt(attemptLevel + 1);
                    } else {
                        resolve(source);
                    }
                }
            };

            img.onerror = (e) => {
                console.warn(`Attempt ${attemptLevel} load failed.`, e);
                if (attemptLevel < 3) {
                    nextAttempt(attemptLevel + 1);
                } else {
                    console.warn("All image load attempts failed. Using original.");
                    resolve(source);
                }
            };
            
            img.src = url;
        };

        const nextAttempt = (level) => {
            if (level === 1) {
                console.log("Retrying with local proxy...");
                // Use local proxy (relative path, works if served from same origin)
                tryLoadImage('/api/proxy?url=' + encodeURIComponent(source), 1);
            } else if (level === 2) {
                console.log("Retrying with corsproxy.io...");
                tryLoadImage('https://corsproxy.io/?' + encodeURIComponent(source), 2);
            } else if (level === 3) {
                console.log("Retrying with allorigins.win...");
                tryLoadImage('https://api.allorigins.win/raw?url=' + encodeURIComponent(source), 3);
            }
        };

        // Start with direct load
        if (typeof source === 'string' && !source.startsWith('data:')) {
            tryLoadImage(source, 0);
        } else {
            resolve(source);
        }
    });
}

// Helper: Get Image Dimensions (with proxy fallback)
const getImageDimensions = (src) => {
    return new Promise((resolve) => {
        const tryLoad = (url, attempt) => {
            const img = new Image();
            img.onload = () => resolve({ width: img.width, height: img.height });
            img.onerror = () => {
                if (attempt === 0) {
                    // Try local proxy
                    tryLoad('/api/proxy?url=' + encodeURIComponent(src), 1);
                } else if (attempt === 1) {
                    // Try corsproxy.io
                    tryLoad('https://corsproxy.io/?' + encodeURIComponent(src), 2);
                } else if (attempt === 2) {
                    // Try allorigins.win
                    tryLoad('https://api.allorigins.win/raw?url=' + encodeURIComponent(src), 3);
                } else {
                    // Give up
                    resolve(null);
                }
            };
            img.src = url;
        };
        
        tryLoad(src, 0);
    });
};
  
  // Helper: Get Effect Shape Data (Native OBR Polygons)
  function getEffectShapeData(type = 'fire') {
      const t = type.toLowerCase().trim();
      
      // Default: Fire/Explosion
      let shapeType = 'POLYGON';
      let points = [];
      let fillColor = '#ffaa00';
      let strokeColor = '#ff0000';
      let strokeWidth = 4;
      
      // Helper to create star/burst points
      const createStar = (spikes, outerRad, innerRad) => {
          const pts = [];
          const cx = 0, cy = 0; // Relative to center
          let rot = Math.PI / 2 * 3;
          const step = Math.PI / spikes;
          
          for (let i = 0; i < spikes; i++) {
              pts.push({ x: cx + Math.cos(rot) * outerRad, y: cy + Math.sin(rot) * outerRad });
              rot += step;
              pts.push({ x: cx + Math.cos(rot) * innerRad, y: cy + Math.sin(rot) * innerRad });
              rot += step;
          }
          return pts;
      };
      
      if (t.includes('fire')) {
          fillColor = '#ffaa00'; strokeColor = '#cc3300';
          points = createStar(12, 150, 60); // Spiky explosion
          
      } else if (t.includes('cold') || t.includes('ice')) {
          fillColor = '#ccffff'; strokeColor = '#0099ff';
          points = createStar(6, 150, 40); // Snowflake-ish
          
      } else if (t.includes('lightning') || t.includes('thunder')) {
          fillColor = '#ffffcc'; strokeColor = '#6633cc';
          // Zig-zag bolt
          points = [
             {x: -20, y: -140}, {x: 40, y: -50}, {x: 0, y: -40},
             {x: 60, y: 60}, {x: 10, y: 50}, {x: 30, y: 140},
             {x: -30, y: 40}, {x: 10, y: 30}, {x: -50, y: -60},
             {x: -10, y: -70}
          ];
          
      } else if (t.includes('acid') || t.includes('poison')) {
          fillColor = '#ccff33'; strokeColor = '#339900';
          // Blobby shape (8 points)
          points = [
             {x: 0, y: -140}, {x: 100, y: -100}, {x: 140, y: 0}, 
             {x: 100, y: 100}, {x: 0, y: 140}, {x: -100, y: 100}, 
             {x: -140, y: 0}, {x: -100, y: -100}
          ];
          
      } else if (t.includes('necrotic')) {
          fillColor = '#330033'; strokeColor = '#cc99ff';
          points = createStar(20, 140, 120); // Spiky void
          
      } else if (t.includes('radiant')) {
          fillColor = '#ffffff'; strokeColor = '#ffcc00';
          points = createStar(30, 150, 20); // Sunburst
          
      } else if (t.includes('force')) {
          fillColor = '#ff99ff'; strokeColor = '#9900cc';
          shapeType = 'CIRCLE'; // Force is a pulse
          points = []; // Ignored for circle
          
      } else if (t.includes('psychic')) {
          fillColor = '#ffccff'; strokeColor = '#ff0066';
          points = createStar(5, 140, 80); // Star
          
      } else {
          // Physical/Generic
          fillColor = '#ff3333'; strokeColor = '#990000';
          points = createStar(8, 120, 90); // Splatter
      }
      
      return { shapeType, points, fillColor, strokeColor, strokeWidth };
  }
  
  // Helper: Trigger Visual Effect on Token
  async function triggerDamageEffect(itemId, damageType = 'force') {
      if (!itemId || !OBR) {
          console.log("Visual Effect Skipped: No itemId or OBR not ready.");
          return;
      }
      
      try {
          const items = await OBR.scene.items.getItems([itemId]);
          if (items.length === 0) return;
          
          const targetItem = items[0];
          
          // Robustly calculate visual dimensions
          const dpi = (targetItem.grid && targetItem.grid.dpi) ? targetItem.grid.dpi : 150;
          const offset = (targetItem.grid && targetItem.grid.offset) ? targetItem.grid.offset : { x: 0, y: 0 };
          const width = targetItem.image ? targetItem.image.width : (targetItem.width || 150);
          const height = targetItem.image ? targetItem.image.height : (targetItem.height || 150);
          const scaleX = (targetItem.scale && targetItem.scale.x) ? targetItem.scale.x : 1;
          const scaleY = (targetItem.scale && targetItem.scale.y) ? targetItem.scale.y : 1;
          
          // Calculate world size in pixels
          const worldWidth = (width / dpi) * 150 * scaleX;
          const worldHeight = (height / dpi) * 150 * scaleY;
          
          // Calculate Center taking into account the item's offset (anchor point)
          // If offset is {0,0}, position is top-left.
          // If offset is {w/2, h/2}, position is center.
          // We want the absolute center in world coordinates.
          // Formula: Pos + (HalfSize - Offset) * ScaleFactor
          const pixelToWorldScaleX = (150 / dpi) * scaleX;
          const pixelToWorldScaleY = (150 / dpi) * scaleY;
          
          const centerX = targetItem.position.x + (width / 2 - offset.x) * pixelToWorldScaleX;
          const centerY = targetItem.position.y + (height / 2 - offset.y) * pixelToWorldScaleY;
          
          // Get shape data
          const { shapeType, points, fillColor, strokeColor, strokeWidth } = getEffectShapeData(damageType);
          
          const effectId = `effect-${Date.now()}`;
          
          // Start small (0.5 scale) and grow
          const startScale = Math.max(worldWidth, worldHeight) / 300 * 0.5;
          const endScale = Math.max(worldWidth, worldHeight) / 300 * 1.5;

          let effectItem;

          if (shapeType === 'POLYGON') {
               // Use Curve for custom polygons (Star, Bolt, etc.)
               // CurveBuilder has .points() method
               effectItem = buildCurve()
                .id(effectId)
                .points(points)
                .tension(0) // 0 tension = straight lines (polygon)
                .closed(true)
                .fillColor(fillColor)
                .fillOpacity(0.7)
                .strokeColor(strokeColor)
                .strokeWidth(strokeWidth)
                .strokeOpacity(1)
                .position({ x: centerX, y: centerY })
                .layer('ATTACHMENT') 
                .locked(false)
                .disableHit(true)
                .scale({ x: startScale, y: startScale })
                .build();
          } else {
               // Use Shape for Standard Shapes (Circle)
               // ShapeBuilder has .width() / .height() but no .points()
               effectItem = buildShape()
                .id(effectId)
                .shapeType('CIRCLE') // We only use CIRCLE here
                .width(300)
                .height(300)
                .fillColor(fillColor)
                .fillOpacity(0.7)
                .strokeColor(strokeColor)
                .strokeWidth(strokeWidth)
                .strokeOpacity(1)
                .position({ x: centerX, y: centerY })
                .layer('ATTACHMENT') 
                .locked(false)
                .disableHit(true)
                .scale({ x: startScale, y: startScale })
                .build();
          }

          // Add effect
          await OBR.scene.items.addItems([effectItem]);
          
          // Animation Frame 1: Expansion
          setTimeout(async () => {
              await OBR.scene.items.updateItems([effectId], (items) => {
                  for (let item of items) {
                      item.scale = { x: endScale, y: endScale };
                      item.style.fillOpacity = 0.4; // Fade out
                  }
              });
          }, 50);

          // Remove after 500ms
          setTimeout(async () => {
              await OBR.scene.items.deleteItems([effectId]);
          }, 500);
          
      } catch (e) {
          console.warn("Failed to trigger visual effect:", JSON.stringify(e));
          console.warn(e);
      }
  }

  // Helper: Manage Deleted Items (Moved to top)


function deleteItem(name) {
    const list = getDeletedItems();
    if (!list.includes(name)) {
        list.push(name);
        localStorage.setItem('dnd_extension_deleted_items', JSON.stringify(list));
        saveToBackend();
    }
}

function deleteItemPermanently(name, type) {
    // Delete from custom lists if present
    if (type === 'monster') {
        const customMonsters = getCustomMonsters().filter(m => m.name !== name);
        localStorage.setItem('dnd_extension_custom_monsters', JSON.stringify(customMonsters));
    } else if (type === 'item') {
        const customItems = getCustomItems().filter(i => i.name !== name);
        localStorage.setItem('dnd_extension_custom_items', JSON.stringify(customItems));
    } else if (type === 'spell') {
        const customSpells = getCustomSpells().filter(s => s.name !== name);
        localStorage.setItem('dnd_extension_custom_spells', JSON.stringify(customSpells));
    }
    
    // Remove from deleted items to restore built-in if applicable
    const deletedList = getDeletedItems().filter(n => n !== name);
    localStorage.setItem('dnd_extension_deleted_items', JSON.stringify(deletedList));
    
    saveToBackend();
}

export function searchItems(query) {
  const deleted = getDeletedItems();
  const customs = getCustomItems();
  const builtIns = items.filter(i => !customs.some(c => c.name === i.name));
  const activeItems = builtIns.filter(i => !deleted.includes(i.name));

  if (!query) return activeItems.slice(0, 50);
  const lowerQuery = query.toLowerCase();
  return activeItems.filter(i => 
      i.name.toLowerCase().includes(lowerQuery) || 
      (i.description && i.description.toLowerCase().includes(lowerQuery))
  ).slice(0, 50);
}

// Helper: Spawn Moveable AoE Template
  async function spawnAoETemplate(itemId, aoe, damageType = 'force') {
      if (!OBR) return;
      
      try {
          let targetX = 0;
          let targetY = 0;
          let targetRotation = 0;

          if (itemId) {
              const items = await OBR.scene.items.getItems([itemId]);
              if (items.length > 0) {
                  const targetItem = items[0];
                  targetX = targetItem.position.x;
                  targetY = targetItem.position.y;
                  targetRotation = targetItem.rotation || 0;
              }
          } else {
             try {
                const pos = await OBR.viewport.getPosition();
                targetX = pos.x;
                targetY = pos.y;
             } catch(e) { console.warn(e); }
          }
          
          // Get Color based on damage type
          const { fillColor, strokeColor } = getEffectShapeData(damageType);
          
          // Calculate Pixels (150px = 5ft)
          const pixelsPerFt = 150 / 5; // 30
          const sizePx = aoe.size * pixelsPerFt;
          
          const templateId = `aoe-${Date.now()}`;
          
          // Helper to apply common styles via Builder
          const applyStyle = (builder) => {
              return builder
                  .id(templateId)
                  .fillColor(fillColor)
                  .fillOpacity(0.3)
                  .strokeColor(strokeColor)
                  .strokeWidth(2)
                  .strokeOpacity(0.8)
                  .layer('PROP')
                  .locked(false)
                  .disableHit(false)
                  .position({ x: targetX, y: targetY })
                  .rotation(targetRotation);
          };

          let templateItem;
 
          // Using Native Shapes (buildCurve/buildShape) instead of generated Images.
          // This avoids "Invalid URL" errors and length limits.
          // Note: Native shapes rotate around their center. Users can drag them into position.

          if (aoe.type === 'cone') {
               // Cone (Triangle)
               const halfWidth = sizePx / 2;
               // Define points relative to the center of the bounding box
               // We'll draw a triangle.
               const points = [
                   { x: 0, y: 0 }, 
                   { x: halfWidth, y: sizePx }, 
                   { x: -halfWidth, y: sizePx }
               ];
               
               templateItem = applyStyle(buildCurve())
                   .points(points)
                   .tension(0)
                   .closed(true)
                   .build();
                   
           } else if (aoe.type === 'line') {
               // Line (Rectangle) - Vertical
               const widthPx = 5 * pixelsPerFt;
               
               templateItem = applyStyle(buildShape())
                   .width(widthPx)
                   .height(sizePx)
                   .shapeType('RECTANGLE')
                   .build();

           } else if (aoe.type === 'wall') {
               // Wall (Rectangle) - Horizontal (Wide)
               // User request: "width not hight" for wall of fire
               const heightPx = 5 * pixelsPerFt; // 5ft thick
               
               templateItem = applyStyle(buildShape())
                   .width(sizePx) // Length is Width
                   .height(heightPx)
                   .shapeType('RECTANGLE')
                   .build();
               
           } else if (aoe.type === 'cube') {
               // Cube (Square)
               templateItem = applyStyle(buildShape())
                   .width(sizePx)
                   .height(sizePx)
                   .shapeType('RECTANGLE')
                   .build();
                   
           } else {
               // Sphere, Cylinder, Radius (Circle)
               const diameter = sizePx * 2;
               templateItem = applyStyle(buildShape())
                   .width(diameter)
                   .height(diameter)
                   .shapeType('CIRCLE')
                   .build();
           }
           
           await OBR.scene.items.addItems([templateItem]);
          
          if (OBR.notification) {
              OBR.notification.show(`Placed ${aoe.size}ft ${aoe.type} template.`);
          }
          
      } catch (e) {
          console.error("Failed to spawn AoE template:", e);
          alert("Error creating template: " + (e.message || e));
      }
  }

  // Setup UI
  export async function setup() {
  console.log("Setup called with URL:", window.location.href);
  const searchParams = new URLSearchParams(window.location.search);
  const sx = searchParams.get('spawnX');
  const sy = searchParams.get('spawnY');
  if (sx && sy) {
      spawnPosition = { x: parseFloat(sx), y: parseFloat(sy) };
      console.log("Spawn position set from URL:", spawnPosition);
  } else {
      console.log("No spawn position in URL");
  }
  
  // Check if current user is GM and get player ID
  let isGM = true; // Default to true for local development
  let playerId = "local_player"; // Default for local development
  try {
      if (window.self !== window.top && OBR && OBR.player) {
          const role = await OBR.player.getRole();
          isGM = role === 'GM';
          if (OBR.player.id) {
              playerId = OBR.player.id;
          }
      }
  } catch (e) {
      console.warn("Could not get player info, using defaults", e);
  }
  console.log("isGM:", isGM);
  console.log("playerId:", playerId);
  
  // Helper functions to get/set per-player settings
  function getSetting(key) {
      return localStorage.getItem(`dnd_extension_${playerId}_${key}`);
  }
  function setSetting(key, value) {
      localStorage.setItem(`dnd_extension_${playerId}_${key}`, value);
  }

  const app = document.getElementById('app');
  app.innerHTML = `
    <div id="drag-handle" style="
        height: 24px; 
        background: #333; 
        border-bottom: 1px solid #555;
        cursor: move; 
        display: flex; 
        align-items: center; 
        justify-content: center;
        user-select: none;
        color: #888;
        font-size: 14px;
    ">
        <span>&#8942;</span>
    </div>
    <div style="padding: 10px; font-family: sans-serif; height: calc(100% - 24px); display: flex; flex-direction: column;">
      <div id="tabs" style="display: flex; gap: 5px; margin-bottom: 10px; border-bottom: 1px solid #ccc; padding-bottom: 5px;">
        ${isGM ? '<button id="tab-monsters" style="flex: 1; padding: 5px; cursor: pointer; background: #ddd; border: none; font-weight: bold;">Monsters</button>' : ''}
        <button id="tab-items" style="flex: 1; padding: 5px; cursor: pointer; background: ${isGM ? '#f0f0f0' : '#ddd'}; border: none; ${!isGM ? 'font-weight: bold;' : ''}">Items</button>
        <button id="tab-spells" style="flex: 1; padding: 5px; cursor: pointer; background: #f0f0f0; border: none;">Spells</button>
        ${isGM ? '<button id="tab-custom" style="flex: 1; padding: 5px; cursor: pointer; background: #f0f0f0; border: none;">Custom</button>' : ''}
      </div>

      <div id="search-view" style="display: flex; flex-direction: column; flex: 1; overflow: hidden;">
        <div style="display: flex; gap: 5px; margin-bottom: 5px;">
            <input type="text" id="search-input" placeholder="Search..." style="flex: 1; padding: 5px; box-sizing: border-box;">
            <button id="random-btn" style="display: none; padding: 0 10px; font-weight: bold; font-size: 1.2em; cursor: pointer; background: #eee; border: 1px solid #ccc; border-radius: 4px;" title="Pick Random Item">🎲</button>
            <button id="create-btn" style="padding: 0 10px; font-weight: bold; font-size: 1.2em; cursor: pointer; background: #eee; border: 1px solid #ccc; border-radius: 4px;" title="Create Custom Entry">+</button>
        </div>
        
        ${isGM ? `<div id="global-settings" style="margin-bottom: 5px; display: flex; gap: 10px; flex-wrap: wrap; padding: 5px; background: #eee; border-radius: 4px;">
            <label style="font-size: 0.8em; cursor: pointer; color: #333; font-weight: bold;">
                <input type="checkbox" id="hide-name-checkbox"> Hide Name
            </label>
            <label style="font-size: 0.8em; cursor: pointer; color: #333; font-weight: bold;">
                <input type="checkbox" id="hide-hp-checkbox"> Hide HP
            </label>
            <label style="font-size: 0.8em; cursor: pointer; color: #333; font-weight: bold;">
                <input type="checkbox" id="hide-ac-checkbox"> Hide AC
            </label>
            <label style="font-size: 0.8em; cursor: pointer; color: #333; font-weight: bold;">
                <input type="checkbox" id="hide-cr-checkbox"> Hide CR
            </label>
        </div>` : ''}
        
        ${isGM ? `<div id="pdf-upload-section" style="margin-bottom: 10px; padding: 10px; background: #f0f8ff; border: 2px dashed #4a90d9; border-radius: 6px; text-align: center;">
            <div style="font-size: 0.9em; font-weight: bold; color: #333; margin-bottom: 8px;">📄 Upload PDF for Monster/Item Extraction</div>
            <input type="file" id="pdf-upload-input" accept=".pdf,application/pdf" style="display: none;">
            <button id="pdf-upload-btn" style="padding: 8px 16px; background: #4a90d9; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">
                Select PDF File
            </button>
            <div style="margin-top: 8px; display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;">
              <button id="ocr-image-btn" style="padding: 6px 12px; background: #ff6b6b; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.85em;">
                📷 OCR Image (PNG/JPG)
              </button>
              <input type="file" id="ocr-image-input" style="display: none;" accept="image/*">
            </div>
            <div id="pdf-upload-status" style="margin-top: 8px; font-size: 0.8em; color: #666;"></div>
            <div id="pdf-extracted-monsters" style="margin-top: 10px; display: none; text-align: left; max-height: 200px; overflow-y: auto; background: white; border: 1px solid #ddd; border-radius: 4px; padding: 8px;">
            </div>
            <div id="pdf-extracted-items" style="margin-top: 10px; display: none; text-align: left; max-height: 200px; overflow-y: auto; background: white; border: 1px solid #ddd; border-radius: 4px; padding: 8px;">
            </div>
        </div>` : ''}

        ${isGM ? `<div id="monster-filters" style="margin-bottom: 10px; display: flex; flex-direction: column; gap: 5px;">
          <label style="font-size: 0.9em; cursor: pointer;">
              <input type="checkbox" id="search-name-only"> Search Name Only
          </label>
          <div style="display: flex; gap: 5px; align-items: center; font-size: 0.9em;">
              <span>CR:</span>
              <input type="text" id="min-cr-input" placeholder="Min (0)" style="width: 50px; padding: 2px;">
              <span>-</span>
              <input type="text" id="max-cr-input" placeholder="Max (30)" style="width: 50px; padding: 2px;">
          </div>
      </div>` : ''}

      <div id="spell-tools" style="display: none; margin-bottom: 10px; background: #f9f9f9; padding: 8px; border: 1px solid #ddd; border-radius: 4px; flex-direction: column; gap: 5px;">
          <div style="font-size: 0.9em; font-weight: bold; margin-bottom: 2px;">Quick AoE Template</div>
          <div style="display: flex; gap: 5px;">
              <select id="quick-aoe-shape" style="flex: 1; padding: 5px;">
                  <option value="cone">Cone</option>
                  <option value="radius">Sphere/Radius</option>
                  <option value="cube">Cube</option>
                  <option value="line">Line</option>
                  <option value="cylinder">Cylinder</option>
              </select>
              <input id="quick-aoe-size" type="number" placeholder="Size (ft)" style="width: 70px; padding: 5px;">
              <button id="quick-aoe-btn" style="padding: 5px 10px; cursor: pointer; background: #4CAF50; color: white; border: none; border-radius: 3px; font-weight: bold;">Place</button>
          </div>
      </div>

        <div id="results" style="overflow-y: auto; flex: 1;"></div>
        
        <div style="margin-top: 5px; border-top: 1px solid #eee; padding-top: 5px; display: flex; justify-content: space-between; align-items: center;">
            <button id="backup-btn" style="font-size: 0.8em; cursor: pointer; background: none; border: 1px solid #ccc; border-radius: 3px; padding: 5px 8px;">Backup Data</button>
            <button id="sync-btn" style="font-size: 0.8em; cursor: pointer; background: none; border: 1px solid #ccc; border-radius: 3px; padding: 5px 8px;" title="Force sync with online database">Force Sync</button>
            <span style="font-size: 0.8em; color: #888;">v1.3.0</span>
            <button id="restore-btn" style="font-size: 0.8em; cursor: pointer; background: none; border: 1px solid #ccc; border-radius: 3px; padding: 5px 8px;">Restore Data</button>
            <button id="export-source-btn" style="font-size: 0.8em; cursor: pointer; background: none; border: 1px solid #007bff; color: #007bff; border-radius: 3px; padding: 5px 8px;" title="Download JSON files to update source code for hosting">Export Source</button>
            <input type="file" id="restore-file-input" style="display: none" accept=".json">
        </div>
      </div>

      <div id="stats-view" style="display: none; height: 100%; overflow-y: auto;">
        <button id="back-btn" style="margin-bottom: 10px;">&larr; Back to Search</button>
        <div id="stats-content"></div>
      </div>

      <div id="editor-view" style="display: none; height: 100%; overflow-y: auto;">
        <button id="editor-cancel-btn" style="margin-bottom: 10px;">&larr; Cancel</button>
        <h3 style="margin-top: 0;"><span id="editor-title-action">Create</span> <span id="editor-title-type">Monster</span></h3>
        
        <div style="display: flex; flex-direction: column; gap: 8px;">
            <input id="editor-name" placeholder="Name" style="padding: 5px; width: 100%; box-sizing: border-box;">
            <input id="editor-image-url" placeholder="Image URL (optional)" style="padding: 5px; width: 100%; box-sizing: border-box;">
            <div style="margin-top: 10px;">
              <input type="file" id="editor-portrait-upload-input" accept="image/*">
            </div>
            <div id="editor-image-preview-container" style="display: none; margin-top: 5px; align-items: center; gap: 10px;">
                <img id="editor-image-preview" style="width: 50px; height: 50px; object-fit: contain; border: 1px solid #555; background: #333;" />
                <span id="editor-image-status" style="font-size: 0.8em; color: #aaa;"></span>
                <button id="editor-clear-image-btn" style="padding: 2px 5px; cursor: pointer; background: #555; border: 1px solid #777; color: white; font-size: 0.8em;">Clear</button>
            </div>
            <div id="editor-used-images-container" style="margin-top: 10px;">
                <div style="font-size: 0.9em; font-weight: bold; margin-bottom: 5px;">Used Images:</div>
                <div id="editor-used-images" style="display: flex; gap: 5px; overflow-x: auto; padding: 5px; border: 1px solid #ddd; border-radius: 4px; min-height: 60px;"></div>
            </div>
            
            <!-- Monster Specific -->
            <div id="editor-monster-fields" style="display: none; flex-direction: column; gap: 8px;">
                <div style="display: flex; gap: 5px;">
                    <input id="editor-hp" placeholder="HP" type="number" style="flex: 1; padding: 5px;">
                    <input id="editor-ac" placeholder="AC" type="number" style="flex: 1; padding: 5px;">
                    <input id="editor-cr" placeholder="CR" style="flex: 1; padding: 5px;">
                </div>
                <input id="editor-type" placeholder="Type (e.g. Humanoid)" style="padding: 5px; width: 100%; box-sizing: border-box;">
                <textarea id="editor-desc" placeholder="Paste Statblock or Description here..." style="height: 150px; padding: 5px; width: 100%; box-sizing: border-box; font-family: monospace;"></textarea>
            </div>

            <!-- Item Specific -->
            <div id="editor-item-fields" style="display: none; flex-direction: column; gap: 8px;">
                 <input id="editor-item-type" placeholder="Type (e.g. Weapon)" style="padding: 5px; width: 100%; box-sizing: border-box;">
                 <input id="editor-rarity" placeholder="Rarity" style="padding: 5px; width: 100%; box-sizing: border-box;">
                 <textarea id="editor-item-desc" placeholder="Description..." style="height: 150px; padding: 5px; width: 100%; box-sizing: border-box; font-family: monospace;"></textarea>
            </div>

            <!-- Spell Specific -->
            <div id="editor-spell-fields" style="display: none; flex-direction: column; gap: 8px;">
                 <div style="display: flex; gap: 5px;">
                     <input id="editor-spell-level" placeholder="Level (0-9)" type="number" min="0" max="9" style="flex: 1; padding: 5px;">
                     <input id="editor-spell-school" placeholder="School (e.g. Evocation)" style="flex: 2; padding: 5px;">
                 </div>
                 <div style="background: #f5f5f5; padding: 5px; border-radius: 4px; border: 1px solid #ddd;">
                    <label style="display: block; font-size: 0.8em; margin-bottom: 3px; font-weight: bold;">Area of Effect (Shape & Size)</label>
                    <div style="display: flex; gap: 5px;">
                        <select id="editor-spell-shape" style="flex: 1; padding: 5px;">
                            <option value="">None (Target)</option>
                            <option value="cone">Cone</option>
                            <option value="radius">Sphere/Radius</option>
                            <option value="cube">Cube</option>
                            <option value="line">Line</option>
                            <option value="cylinder">Cylinder</option>
                        </select>
                        <input id="editor-spell-size" type="number" placeholder="Size (ft)" style="width: 80px; padding: 5px;">
                    </div>
                    <button id="editor-cast-shape-btn" style="width: 100%; margin-top: 5px; padding: 5px; background: #666; color: white; border: none; cursor: pointer; border-radius: 3px;">Cast Custom Shape Now</button>
                 </div>
                 <textarea id="editor-spell-desc" placeholder="Description / Details..." style="height: 150px; padding: 5px; width: 100%; box-sizing: border-box; font-family: monospace;"></textarea>
            </div>

            <button id="editor-save-btn" style="padding: 10px; background: #4CAF50; color: white; border: none; cursor: pointer; font-weight: bold; margin-top: 10px; border-radius: 4px;">Save Custom Entry</button>
        </div>
      </div>
    </div>
  `;

  let activeTab = isGM ? 'monsters' : 'items'; // Default to items for non-GM

  const tabMonsters = document.getElementById('tab-monsters');
  const tabItems = document.getElementById('tab-items');
  const tabSpells = document.getElementById('tab-spells');
  const tabCustom = document.getElementById('tab-custom');
  const monsterFilters = document.getElementById('monster-filters');
  const globalSettings = document.getElementById('global-settings');
  const spellTools = document.getElementById('spell-tools');
  const quickAoeBtn = document.getElementById('quick-aoe-btn');
  const quickAoeShape = document.getElementById('quick-aoe-shape');
  const quickAoeSize = document.getElementById('quick-aoe-size');
  
  const input = document.getElementById('search-input');
  const searchNameOnlyCheckbox = isGM ? document.getElementById('search-name-only') : null;
  const minCrInput = isGM ? document.getElementById('min-cr-input') : null;
  const maxCrInput = isGM ? document.getElementById('max-cr-input') : null;
  const hideNameCheckbox = isGM ? document.getElementById('hide-name-checkbox') : null;
  const hideHpCheckbox = isGM ? document.getElementById('hide-hp-checkbox') : null;
  const hideAcCheckbox = isGM ? document.getElementById('hide-ac-checkbox') : null;
  const hideCrCheckbox = isGM ? document.getElementById('hide-cr-checkbox') : null;

  // Load hide settings only if GM
  if (isGM) {
      hideNameCheckbox.checked = getSetting('hide_name') === 'true';
      hideHpCheckbox.checked = getSetting('hide_hp') === 'true';
      hideAcCheckbox.checked = getSetting('hide_ac') === 'true';
      hideCrCheckbox.checked = getSetting('hide_cr') === 'true';
  }

  const updateAllTokensOnMap = async () => {
      if (!isGM) return; // Only GM can update tokens
      
      const hName = hideNameCheckbox.checked;
      const hHP = hideHpCheckbox.checked;
      const hAC = hideAcCheckbox.checked;
      const hCR = hideCrCheckbox.checked;

      try {
          const items = await OBR.scene.items.getItems();
          const extensionItems = items.filter(item => 
              item.metadata && (
                  item.metadata.created_by === 'dnd_extension' || 
                  item.metadata.created_by === 'dnd_extension_item'
              )
          );

          if (extensionItems.length > 0) {
              await OBR.scene.items.updateItems(extensionItems.map(i => i.id), (items) => {
                  for (let item of items) {
                      const isMonster = item.metadata.created_by === 'dnd_extension';
                      let name = item.metadata.name;

                      // One-time migration for older tokens missing the name in metadata
                      if (isMonster && !name && item.text && item.text.plainText) {
                          const firstLine = item.text.plainText.split('\n')[0];
                          // If the first line isn't a stat, assume it's the name
                          if (!firstLine.startsWith('HP:') && !firstLine.startsWith('AC:')) {
                              name = firstLine;
                              // Persist this back to the metadata! This is the crucial fix.
                              item.metadata.name = name; 
                          }
                      }
                      if (!name) name = "Unknown"; // Fallback

                      const hp = item.metadata.hp;
                      const ac = item.metadata.ac;
                      let cr = item.metadata.cr;
                      const type = item.metadata.type;

                      console.log("updateAllTokensOnMap - token cr metadata:", cr);

                      // If token is missing cr metadata, try to find it in monsters or custom monsters library
                      if (isMonster && (!cr || cr === "Unknown")) {
                          const allMonsters = [...monsters, ...getCustomMonsters()];
                          const libraryMonster = allMonsters.find(m => m.name === name);
                          if (libraryMonster) {
                              cr = libraryMonster.cr;
                              // Also save it back to token's metadata so we don't have to look it up again!
                              item.metadata.cr = String(cr);
                              console.log("updateAllTokensOnMap - found cr in library:", cr);
                          }
                      }

                      let newLabel = "";
                      if (!hName) newLabel += name;
                      
                      if (isMonster) {
                          let statsLine = "";
                          const hasHp = !hHP && hp !== undefined;
                          const hasAc = !hAC && ac !== undefined;
                          const hasCr = !hCR && cr !== undefined && cr !== "Unknown";
                          
                          if (hasHp) statsLine += `HP: ${hp}`;
                          if (hasHp && hasAc) statsLine += " ";
                          if (hasAc) statsLine += `AC: ${ac}`;
                          if ((hasHp || hasAc) && hasCr) statsLine += " ";
                          if (hasCr) statsLine += `CR: ${cr}`;
                          
                          if (statsLine) {
                              if (newLabel) newLabel += "\n";
                              newLabel += statsLine;
                          }
                      } else {
                          // Item label logic
                          if (type) {
                              if (newLabel) newLabel += "\n";
                              newLabel += type;
                          } else if (!newLabel) {
                              newLabel = "Item";
                          }
                      }
                      
                      if (!item.text) item.text = { plainText: "" };
                      item.text.plainText = newLabel;
                  }
              });
          }
      } catch (e) {
          console.error("Failed to update tokens on map:", e);
      }
  };

  if (isGM) {
      hideNameCheckbox.addEventListener('change', () => {
          setSetting('hide_name', hideNameCheckbox.checked);
          updateAllTokensOnMap();
      });
      hideHpCheckbox.addEventListener('change', () => {
          setSetting('hide_hp', hideHpCheckbox.checked);
          updateAllTokensOnMap();
      });
      hideAcCheckbox.addEventListener('change', () => {
          setSetting('hide_ac', hideAcCheckbox.checked);
          updateAllTokensOnMap();
      });
      hideCrCheckbox.addEventListener('change', () => {
          setSetting('hide_cr', hideCrCheckbox.checked);
          updateAllTokensOnMap();
      });
  }

  const resultsDiv = document.getElementById('results');
  const searchView = document.getElementById('search-view');
  const statsView = document.getElementById('stats-view');
  const statsContent = document.getElementById('stats-content');
  const backBtn = document.getElementById('back-btn');

  // Editor Elements
  const createBtn = document.getElementById('create-btn');
  const randomBtn = document.getElementById('random-btn');
  const editorView = document.getElementById('editor-view');
  const editorCancelBtn = document.getElementById('editor-cancel-btn');
  const editorSaveBtn = document.getElementById('editor-save-btn');
  const editorName = document.getElementById('editor-name');
  const editorImageUrl = document.getElementById('editor-image-url');
  const editorImagePreviewContainer = document.getElementById('editor-image-preview-container');
  const editorImagePreview = document.getElementById('editor-image-preview');
  const editorImageStatus = document.getElementById('editor-image-status');
  const editorClearImageBtn = document.getElementById('editor-clear-image-btn');
  const editorPortraitUploadInput = document.getElementById('editor-portrait-upload-input');
  const editorUsedImages = document.getElementById('editor-used-images');
  const editorMonsterFields = document.getElementById('editor-monster-fields');
  const editorItemFields = document.getElementById('editor-item-fields');
  const editorSpellFields = document.getElementById('editor-spell-fields');
  
  const editorHp = document.getElementById('editor-hp');
  const editorAc = document.getElementById('editor-ac');
  const editorCr = document.getElementById('editor-cr');
  const editorType = document.getElementById('editor-type');
  const editorDesc = document.getElementById('editor-desc');

  const editorItemType = document.getElementById('editor-item-type');
  const editorRarity = document.getElementById('editor-rarity');
  const editorItemDesc = document.getElementById('editor-item-desc');

  const editorSpellLevel = document.getElementById('editor-spell-level');
  const editorSpellSchool = document.getElementById('editor-spell-school');
  const editorSpellShape = document.getElementById('editor-spell-shape');
  const editorSpellSize = document.getElementById('editor-spell-size');
  const editorCastShapeBtn = document.getElementById('editor-cast-shape-btn');
  const editorSpellDesc = document.getElementById('editor-spell-desc');

  let lastParsedStatBlock = null;
  
  // Helper to auto-fill form fields from stat block
  function autoFillFromStatBlock() {
    const text = editorDesc.value;
    const parsed = parseStatBlock(text);
    lastParsedStatBlock = parsed;
    
    if (parsed.name && !editorName.value) {
      editorName.value = parsed.name;
    }
    if (parsed.type && !editorType.value) {
      editorType.value = parsed.type;
    }
    if (parsed.ac !== undefined && !editorAc.value) {
      editorAc.value = parsed.ac;
    }
    if (parsed.hp !== undefined && !editorHp.value) {
      editorHp.value = parsed.hp;
    }
    if (parsed.cr && !editorCr.value) {
      editorCr.value = parsed.cr;
    }
  }

  // Fix PDF Copy-Paste Artifacts (e.g. "Text%With%Percents" instead of spaces)
  const cleanPdfPaste = (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (!text || !text.includes('%')) return;

      // Only intervene if it looks like the specific artifact:
      // 1. No spaces (the artifact replaces spaces with %)
      // 2. Contains multiple % signs (indicating it's acting as a separator)
      if (!text.includes(' ') && (text.match(/%/g) || []).length > 1) {
          let cleaned = text;
          
          // Try standard decode first (e.g. %20)
          try {
              const decoded = decodeURIComponent(text);
              // If fully decoded and reasonable, use it
              // But if it fails or returns something that still looks encoded, fallback
              if (decoded !== text) {
                   cleaned = decoded;
              } else {
                   throw new Error("No change");
              }
          } catch (err) {
              // Fallback: simple replacement for "This%brass%encased" style
              cleaned = text.replace(/%/g, ' ');
          }

          // If we still have % after decode attempt and it still looks like the artifact, force replace
          // (Catch-all for mixed or invalid sequences)
          if (cleaned.includes('%') && !cleaned.includes(' ')) {
              cleaned = cleaned.replace(/%/g, ' ');
          }

          e.preventDefault();
          const el = e.target;
          const start = el.selectionStart;
          const end = el.selectionEnd;
          const original = el.value;
          
          el.value = original.substring(0, start) + cleaned + original.substring(end);
          el.selectionStart = el.selectionEnd = start + cleaned.length;
      }
  };

  if (editorDesc) {
    editorDesc.addEventListener('paste', cleanPdfPaste);
    editorDesc.addEventListener('input', autoFillFromStatBlock);
  }
  if (editorItemDesc) editorItemDesc.addEventListener('paste', cleanPdfPaste);
  
  // Portrait Upload Logic - SUPER SIMPLE!
  if (editorPortraitUploadInput) {
    editorPortraitUploadInput.addEventListener('change', function(e) {
      const file = e.target.files[0];
      if (!file) return;
      
      const reader = new FileReader();
      reader.onload = function(event) {
        const base64 = event.target.result;
        editorImageUrl.value = base64;
        editorImagePreview.src = base64;
        editorImagePreviewContainer.style.display = 'flex';
        editorImageStatus.innerText = 'Uploaded!';
      };
      reader.readAsDataURL(file);
    });
  }

  let editorMode = 'monster'; 
  let editorOriginalName = null;
  let editorOriginalSource = null;

  const openEditor = (mode, data = null) => {
      editorMode = mode;
      editorOriginalName = data ? data.name : null;
      editorOriginalSource = data ? data.source : null;
      
      document.getElementById('editor-title-action').innerText = data ? "Edit" : "Create";
    document.getElementById('editor-title-type').innerText = mode === 'monster' ? "Monster" : (mode === 'spell' ? "Spell" : "Item");
    
    // Load Image URL if exists
      let imgKey;
      if (mode === 'monster') imgKey = 'monster_image_' + (data ? data.name : '');
      else if (mode === 'spell') imgKey = 'spell_image_' + (data ? data.name : '');
      else imgKey = 'item_image_' + (data ? data.name : '');

      const existingImg = localStorage.getItem(imgKey);
      editorImageUrl.value = existingImg || '';

      // Update Preview
      if (existingImg) {
          editorImagePreview.src = existingImg;
          editorImagePreviewContainer.style.display = 'flex';
          editorImageStatus.innerText = 'Stored Image';
      } else {
          editorImagePreviewContainer.style.display = 'none';
      }

      // Render used images for this entry
      const entryName = data ? data.name : null;
      let usedImagesForEntry = [];
      
      // Add current image first if it exists
      if (existingImg) {
        usedImagesForEntry.push(existingImg);
      }
      
      // Add other used images for this entry (without duplicates)
      if (entryName) {
        const entryHistory = getUsedImagesForEntry(entryName);
        entryHistory.forEach(url => {
          if (!usedImagesForEntry.includes(url)) {
            usedImagesForEntry.push(url);
          }
        });
      }
      
      editorUsedImages.innerHTML = usedImagesForEntry.map((url, idx) => `
        <img src="${url}" data-url="${url}" style="width: 50px; height: 50px; object-fit: contain; border: 2px solid ${idx === 0 && existingImg === url ? '#2196F3' : '#ddd'}; border-radius: 4px; cursor: pointer; background: #333;" title="Click to use this image" />
      `).join('');

      // Add click handlers to used images
      editorUsedImages.querySelectorAll('img').forEach(img => {
        img.addEventListener('click', () => {
          const url = img.dataset.url;
          editorImageUrl.value = url;
          editorImagePreview.src = url;
          editorImagePreviewContainer.style.display = 'flex';
          editorImageStatus.innerText = 'Used Image';
        });
      });

      if (mode === 'monster') {
          editorMonsterFields.style.display = 'flex';
          editorItemFields.style.display = 'none';
          editorSpellFields.style.display = 'none';
          
          editorName.value = data ? data.name : '';
          editorHp.value = data ? data.hp || '' : '';
          editorAc.value = data ? data.ac || '' : '';
          editorCr.value = data ? data.cr || '' : '';
          editorType.value = data ? data.type || '' : '';
          editorDesc.value = data ? data.description || '' : '';
          
          lastParsedStatBlock = data ? {
            stats: data.stats || {},
            savingThrows: data.savingThrows,
            skills: data.skills,
            senses: data.senses,
            languages: data.languages,
            damageResistances: data.damageResistances,
            damageImmunities: data.damageImmunities,
            conditionImmunities: data.conditionImmunities
          } : null;
      } else if (mode === 'spell') {
          editorMonsterFields.style.display = 'none';
          editorItemFields.style.display = 'none';
          editorSpellFields.style.display = 'flex';
          
          editorName.value = data ? data.name : '';
          editorSpellLevel.value = data ? (data.level !== undefined ? data.level : '') : '';
          editorSpellSchool.value = data ? data.school || '' : '';
          editorSpellDesc.value = data ? data.description || '' : '';
          
          if (data && data.aoe) {
              editorSpellShape.value = data.aoe.type;
              editorSpellSize.value = data.aoe.size;
          } else {
              editorSpellShape.value = "";
              editorSpellSize.value = "";
          }
      } else {
          editorMonsterFields.style.display = 'none';
          editorItemFields.style.display = 'flex';
          editorSpellFields.style.display = 'none';
          
          editorName.value = data ? data.name : '';
          editorItemType.value = data ? data.type || '' : '';
          editorRarity.value = data ? data.rarity || '' : '';
          editorItemDesc.value = data ? data.description || '' : '';
      }

      searchView.style.display = 'none';
      statsView.style.display = 'none';
      editorView.style.display = 'block';
  };

  createBtn.addEventListener('click', () => {
      if (activeTab === 'monsters' || activeTab === 'custom') openEditor('monster');
      else if (activeTab === 'items') openEditor('item');
      else if (activeTab === 'spells') openEditor('spell');
  });

  if (quickAoeBtn) {
      quickAoeBtn.addEventListener('click', async () => {
          const type = quickAoeShape.value;
          const size = parseInt(quickAoeSize.value);
          
          if (!type || !size) {
              alert("Please enter a size.");
              return;
          }
          
          // Try to get selected item, otherwise spawn at center
          let targetId = null;
          try {
              const selection = await OBR.player.getSelection();
              if (selection && selection.length > 0) {
                   targetId = selection[0];
              }
          } catch(e) { console.warn(e); }
          
          spawnAoETemplate(targetId, { type, size }, 'force');
      });
  }

  // Image Preview Logic
  editorImageUrl.addEventListener('input', () => {
      const url = editorImageUrl.value.trim();
      if (url) {
          editorImagePreview.src = url;
          editorImagePreviewContainer.style.display = 'flex';
          editorImageStatus.innerText = 'Preview';
      } else {
          editorImagePreviewContainer.style.display = 'none';
      }
  });

  editorClearImageBtn.addEventListener('click', () => {
      editorImageUrl.value = '';
      editorImagePreviewContainer.style.display = 'none';
  });

  editorCancelBtn.addEventListener('click', () => {
      editorView.style.display = 'none';
      searchView.style.display = 'flex';
  });
  
  // Cast Shape Button in Editor
  if (editorCastShapeBtn) {
      editorCastShapeBtn.addEventListener('click', async () => {
          const type = editorSpellShape.value;
          const size = parseInt(editorSpellSize.value);
          
          if (!type || !size) {
              alert("Please select a shape and size first.");
              return;
          }
          
          // Try to get selected item, otherwise spawn at center
          let targetId = null;
          try {
              const selection = await OBR.player.getSelection();
              if (selection && selection.length > 0) {
                   targetId = selection[0];
              }
          } catch(e) { console.warn(e); }
          
          spawnAoETemplate(targetId, { type, size }, 'force');
      });
  }

  editorSaveBtn.addEventListener('click', async () => {
      const name = editorName.value.trim();
      if (!name) {
          alert("Name is required");
          return;
      }

      // Save Image URL manually if provided
      let newImgUrl = editorImageUrl.value.trim();
      let imageSaved = false;
      const imgKey = editorMode === 'monster' ? 'monster_image_' + name : (editorMode === 'spell' ? 'spell_image_' + name : 'item_image_' + name);

      if (newImgUrl) {
          // Optimize URL (upload if long Base64)
          try {
              let folder = 'monsters';
              if (editorMode === 'spell') folder = 'spells';
              else if (editorMode !== 'monster') folder = 'items';
              
              newImgUrl = await ensureShortImageUrl(newImgUrl, name, folder);
          } catch (e) {
              console.warn("Failed to optimize image URL:", e);
          }

          try {
              localStorage.setItem(imgKey, newImgUrl);
              addUsedImageForEntry(name, newImgUrl);
              // Verify immediately
              const saved = localStorage.getItem(imgKey);
              if (!saved || saved !== newImgUrl) {
                 throw new Error("Verification failed: Saved value does not match.");
              }
              imageSaved = true;
          } catch (e) {
              console.error("Storage limit reached or save failed:", e);
              alert("❌ IMAGE NOT SAVED!\n\nLocal storage is full. The text data will be saved, but the image is too large.\n\nTip: Use 'npm start' to enable the local server for unlimited image storage, or use smaller images.");
          }
      } else {
          // If the URL is cleared, remove the image from storage
          localStorage.removeItem(imgKey);
      }

      if (editorMode === 'monster') {
          const newMonster = {
              name: name,
              hp: parseInt(editorHp.value) || 0,
              ac: parseInt(editorAc.value) || 10,
              cr: editorCr.value,
              type: editorType.value,
              description: editorDesc.value,
              source: editorOriginalSource || "Custom",
              stats: lastParsedStatBlock?.stats || {},
              savingThrows: lastParsedStatBlock?.savingThrows,
              skills: lastParsedStatBlock?.skills,
              senses: lastParsedStatBlock?.senses,
              languages: lastParsedStatBlock?.languages,
              damageResistances: lastParsedStatBlock?.damageResistances,
              damageImmunities: lastParsedStatBlock?.damageImmunities,
              conditionImmunities: lastParsedStatBlock?.conditionImmunities,
              // Backup: Save image in object if it's short (not Base64) or if we want to force it
              // We only save it in the object if it's NOT a huge data URI, to prevent bloating the main list
              image: (newImgUrl && !newImgUrl.startsWith('data:')) ? newImgUrl : undefined
          };
          if (!saveCustomMonster(newMonster)) return;

          // Sync Library -> Tokens: Update existing OBR tokens for this monster
          try {
              const items = await OBR.scene.items.getItems();
              const toUpdate = items.filter(item => {
                  if (item.type !== 'IMAGE') return false;
                  // Match by Name (heuristic: text label starts with name)
                  const text = item.text?.plainText || "";
                  // Also check metadata if available
                  const metaName = item.metadata?.name;
                  if (metaName && metaName === name) return true;
                  
                  return text.startsWith(name);
              });

              if (toUpdate.length > 0) {
                  if (confirm(`Update ${toUpdate.length} existing tokens on the map with these new stats?`)) {
                      await OBR.scene.items.updateItems(toUpdate.map(i => i.id), (items) => {
                          for (let item of items) {
                              // Update Metadata
                              if (!item.metadata) item.metadata = {};
                              item.metadata.hp = newMonster.hp;
                              item.metadata.ac = newMonster.ac;
                              item.metadata.name = newMonster.name; // Ensure name is in metadata for future sync
                              
                              // Update Text Label
                              // Respect hide settings
                              const hideName = localStorage.getItem('dnd_extension_hide_name') === 'true';
                              const hideHP = localStorage.getItem('dnd_extension_hide_hp') === 'true';
                              const hideAC = localStorage.getItem('dnd_extension_hide_ac') === 'true';

                              let newLabel = "";
                              if (!hideName) newLabel += newMonster.name;
                              
                              let statsLine = "";
                              if (!hideHP) statsLine += `HP: ${newMonster.hp}`;
                              if (!hideHP && !hideAC) statsLine += " ";
                              if (!hideAC) statsLine += `AC: ${newMonster.ac}`;
                              
                              if (statsLine) {
                                  if (newLabel) newLabel += "\n";
                                  newLabel += statsLine;
                              }
                              item.text.plainText = newLabel;
                              
                              // Update Image if changed
                              if (newImgUrl && item.image) {
                                  item.image.url = newImgUrl;
                                  // Reset MIME to let OBR re-detect or default
                                  if (newImgUrl.endsWith('.svg') || newImgUrl.includes('.svg?')) {
                                      item.image.mime = 'image/svg+xml';
                                  }
                              }
                          }
                      });
                  }
              }
          } catch (e) {
              console.error("Failed to sync tokens:", e);
          }

      } else if (editorMode === 'spell') {
          const aoeType = editorSpellShape.value;
          const aoeSize = parseInt(editorSpellSize.value);
          
          const newSpell = {
              name: name,
              level: parseInt(editorSpellLevel.value) || 0,
              school: editorSpellSchool.value,
              description: editorSpellDesc.value,
              source: editorOriginalSource || "Custom",
              aoe: (aoeType && aoeSize) ? { type: aoeType, size: aoeSize } : undefined
          };
          if (!saveCustomSpell(newSpell)) return;
      } else {
          const newItem = {
              name: name,
              type: editorItemType.value,
              rarity: editorRarity.value,
              description: editorItemDesc.value,
              source: editorOriginalSource || "Custom",
              image: (newImgUrl && !newImgUrl.startsWith('data:')) ? newImgUrl : undefined
          };
          if (!saveCustomItem(newItem)) return;
      }
      
      // Handle Rename of Custom Item (Cleanup old)
      if (editorOriginalName && editorOriginalName !== name) {
          if (editorMode === 'monster') {
              const customs = getCustomMonsters();
              const oldIdx = customs.findIndex(m => m.name === editorOriginalName);
              if (oldIdx !== -1) {
                  // It was a custom monster
                  if (confirm(`Do you want to delete the old entry "${editorOriginalName}"?`)) {
                      customs.splice(oldIdx, 1);
                      localStorage.setItem('dnd_extension_custom_monsters', JSON.stringify(customs));

                      // Cleanup old image
                      const oldImgKey = 'monster_image_' + editorOriginalName;
                      localStorage.removeItem(oldImgKey);
                  }
              } else {
                  // It was a built-in monster. Hide the original so it looks like a rename.
                  if (confirm(`Do you want to hide the original entry "${editorOriginalName}"?`)) {
                      deleteItem(editorOriginalName);
                  }
              }
          } else if (editorMode === 'spell') {
              const customs = getCustomSpells();
              const oldIdx = customs.findIndex(s => s.name === editorOriginalName);
              if (oldIdx !== -1) {
                  // It was a custom spell
                  if (confirm(`Do you want to delete the old entry "${editorOriginalName}"?`)) {
                      customs.splice(oldIdx, 1);
                      localStorage.setItem('dnd_extension_custom_spells', JSON.stringify(customs));

                      // Cleanup old image
                      const oldImgKey = 'spell_image_' + editorOriginalName;
                      localStorage.removeItem(oldImgKey);
                  }
              } else {
                  // Built-in spell
                  if (confirm(`Do you want to hide the original entry "${editorOriginalName}"?`)) {
                      deleteItem(editorOriginalName);
                  }
              }
          } else {
              const customs = getCustomItems();
              const oldIdx = customs.findIndex(i => i.name === editorOriginalName);
              if (oldIdx !== -1) {
                  if (confirm(`Do you want to delete the old entry "${editorOriginalName}"?`)) {
                      customs.splice(oldIdx, 1);
                      localStorage.setItem('dnd_extension_custom_items', JSON.stringify(customs));

                      // Cleanup old image
                      const oldImgKey = 'item_image_' + editorOriginalName;
                      localStorage.removeItem(oldImgKey);
                  }
              } else {
                  // It was a built-in item. Hide the original so it looks like a rename.
                  if (confirm(`Do you want to hide the original entry "${editorOriginalName}"?`)) {
                      deleteItem(editorOriginalName);
                  }
              }
          }
      }
      
      if (imageSaved) {
          alert(`Saved ${name}!`);
      } else if (newImgUrl) {
          alert(`Saved ${name} (Text Only). Image was not saved.`);
      } else {
          alert(`Saved ${name}!`);
      }
      editorView.style.display = 'none';
      searchView.style.display = 'flex';
      renderResults(input.value);
  });

  // Backup / Restore Logic
  const backupBtn = document.getElementById('backup-btn');
  const syncBtn = document.getElementById('sync-btn');
  const restoreBtn = document.getElementById('restore-btn');
  const restoreInput = document.getElementById('restore-file-input');

  if (syncBtn) {
      syncBtn.addEventListener('click', async () => {
          syncBtn.innerText = "Syncing...";
          syncBtn.disabled = true;
          try {
              await syncWithBackend();
              alert("Sync completed! If new data was found, the list has been updated.");
          } catch (e) {
              alert("Sync failed: " + e.message);
          } finally {
              syncBtn.innerText = "Force Sync";
              syncBtn.disabled = false;
          }
      });
  }

  if (backupBtn) {
      backupBtn.addEventListener('click', () => {
          const data = {};
          let count = 0;
          for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              // Backup our keys: custom data, deleted items, images
            if (key.startsWith('dnd_extension_') || key.startsWith('monster_image_') || key.startsWith('item_image_') || key.startsWith('spell_image_')) {
                data[key] = localStorage.getItem(key);
                count++;
            }
          }
          
          if (count === 0) {
              alert("No custom data found to backup.");
              return;
          }

          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `owlbear-dnd-backup-${new Date().toISOString().split('T')[0]}.json`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
      });
  }

  if (restoreBtn && restoreInput) {
      restoreBtn.addEventListener('click', () => restoreInput.click());
      
      restoreInput.addEventListener('change', (e) => {
          const file = e.target.files[0];
          if (!file) return;
          
          const reader = new FileReader();
          reader.onload = (event) => {
              try {
                  const data = JSON.parse(event.target.result);
                  let count = 0;
                  Object.keys(data).forEach(key => {
                      if (key.startsWith('dnd_extension_') || key.startsWith('monster_image_') || key.startsWith('item_image_') || key.startsWith('spell_image_')) {
                          localStorage.setItem(key, data[key]);
                          count++;
                      }
                  });
                  alert(`Restored ${count} data entries! Reloading...`);
                  window.location.reload();
              } catch (err) {
                  alert("Failed to restore data: " + err.message);
              }
          };
          reader.readAsText(file);
      });
  }

  // PDF Upload Logic
  const pdfUploadBtn = document.getElementById('pdf-upload-btn');
  const pdfUploadInput = document.getElementById('pdf-upload-input');
  const pdfUploadStatus = document.getElementById('pdf-upload-status');
  const pdfExtractedMonsters = document.getElementById('pdf-extracted-monsters');
  const pdfExtractedItems = document.getElementById('pdf-extracted-items');
  const pdfUploadSection = document.getElementById('pdf-upload-section');

  if (pdfUploadBtn && pdfUploadInput) {
    pdfUploadBtn.addEventListener('click', () => pdfUploadInput.click());
    
    pdfUploadInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      pdfUploadStatus.style.color = '#333';
      pdfUploadStatus.textContent = `Processing: ${file.name}...`;
      pdfExtractedMonsters.style.display = 'none';
      pdfExtractedItems.style.display = 'none';
      
      try {
        const text = await extractTextFromPDF(file);
        
        let extractedMonsters = [];
        let extractedItems = [];
        
        // Always use AI extraction first, fall back to basic if AI fails
        try {
          pdfUploadStatus.textContent = 'Extracting with AI...';
          const aiResult = await extractWithAI(text);
          extractedMonsters = aiResult.monsters || [];
          extractedItems = aiResult.items || [];
          
          // Format monsters to match existing structure
          extractedMonsters = extractedMonsters.map(m => ({
            rawText: m.rawText,
            parsed: {
              name: m.name,
              hp: m.hp,
              ac: m.ac,
              cr: m.cr,
              type: m.type
            }
          }));
          
          // Format items to match existing structure
          extractedItems = extractedItems.map(i => ({
            rawText: i.rawText,
            parsed: {
              name: i.name,
              type: i.type,
              rarity: i.rarity,
              description: i.rawText
            }
          }));
        } catch (aiError) {
          console.warn('AI extraction failed, using basic extraction:', aiError);
          pdfUploadStatus.textContent = 'AI extraction failed, using basic extraction...';
          extractedMonsters = extractMonstersFromPDFText(text);
          extractedItems = extractItemsFromPDFText(text);
        }
        
        if (extractedMonsters.length === 0 && extractedItems.length === 0) {
          pdfUploadStatus.style.color = '#ff6b6b';
          pdfUploadStatus.innerHTML = `
            No monsters or items found in PDF.<br>
            <span style="font-size: 0.8em; color: #888;">
              Extracted ${text.length} characters. 
              <button id="show-extracted-text-btn" style="background: none; border: none; color: #4a90d9; cursor: pointer; text-decoration: underline;">Show sample text</button>
            </span>
          `;
          
          setTimeout(() => {
            const showBtn = document.getElementById('show-extracted-text-btn');
            if (showBtn) {
              showBtn.addEventListener('click', () => {
                let cleanText = text;
                cleanText = cleanText.replace(/---TOP_OF_PAGE---/g, '');
                cleanText = cleanText.replace(/---PAGE_BREAK---/g, '');
                cleanText = cleanText.replace(/\n\s*\n\s*\n/g, '\n\n');
                const sample = cleanText.trim().substring(0, 2000);
                alert('Extracted text sample (first 2000 chars):\n\n' + sample);
              });
            }
          }, 0);
          
          return;
        }
        
        const savedMonsterCount = saveExtractedMonstersToGlobal(extractedMonsters);
        const savedItemCount = saveExtractedItemsToGlobal(extractedItems);
        
        pdfUploadStatus.style.color = '#4CAF50';
        pdfUploadStatus.innerHTML = `Success! Found ${extractedMonsters.length} monster(s) and ${extractedItems.length} item(s). Saved ${savedMonsterCount} monster(s) and ${savedItemCount} item(s) to global storage.<br>
          <span style="font-size: 0.8em; color: #888;">
            <button id="show-full-extracted-btn" style="background: none; border: none; color: #4a90d9; cursor: pointer; text-decoration: underline; margin-top: 5px;">Show Full Extracted Text</button>
          </span>`;
        
        // Show extracted monsters
        if (extractedMonsters.length > 0) {
          pdfExtractedMonsters.style.display = 'block';
          pdfExtractedMonsters.innerHTML = `<div style="font-weight: bold; margin-bottom: 8px; color: #333;">Extracted Monsters:</div>` + extractedMonsters.map((m, idx) => {
            const name = m.parsed?.name || `Monster ${idx + 1}`;
            const stats = [];
            if (m.parsed?.ac) stats.push(`AC: ${m.parsed.ac}`);
            if (m.parsed?.hp) stats.push(`HP: ${m.parsed.hp}`);
            if (m.parsed?.cr) stats.push(`CR: ${m.parsed.cr}`);
            
            return `
              <div style="padding: 8px; border-bottom: 1px solid #eee; cursor: pointer;" class="extracted-monster-item" data-index="${idx}">
                <div style="font-weight: bold; color: #333;">${name}</div>
                <div style="font-size: 0.8em; color: #666;">${stats.join(' | ')}</div>
              </div>
            `;
          }).join('');
          
          pdfExtractedMonsters.querySelectorAll('.extracted-monster-item').forEach((item, idx) => {
            item.addEventListener('click', () => {
              const monster = extractedMonsters[idx];
              openEditor('monster', {
                name: monster.parsed?.name || '',
                hp: monster.parsed?.hp || '',
                ac: monster.parsed?.ac || '',
                cr: monster.parsed?.cr || '',
                type: monster.parsed?.type || '',
                description: monster.rawText || ''
              });
            });
          });
        }
        
        // Show extracted items
        if (extractedItems.length > 0) {
          pdfExtractedItems.style.display = 'block';
          pdfExtractedItems.innerHTML = `<div style="font-weight: bold; margin-bottom: 8px; color: #333;">Extracted Items:</div>` + extractedItems.map((i, idx) => {
            const name = i.parsed?.name || `Item ${idx + 1}`;
            const details = [];
            if (i.parsed?.type) details.push(i.parsed.type);
            if (i.parsed?.rarity) details.push(i.parsed.rarity);
            
            return `
              <div style="padding: 8px; border-bottom: 1px solid #eee; cursor: pointer;" class="extracted-item-item" data-index="${idx}">
                <div style="font-weight: bold; color: #333;">${name}</div>
                <div style="font-size: 0.8em; color: #666;">${details.join(' | ')}</div>
              </div>
            `;
          }).join('');
          
          pdfExtractedItems.querySelectorAll('.extracted-item-item').forEach((item, idx) => {
            item.addEventListener('click', () => {
              const itemData = extractedItems[idx];
              openEditor('item', {
                name: itemData.parsed?.name || '',
                type: itemData.parsed?.type || '',
                rarity: itemData.parsed?.rarity || '',
                description: itemData.rawText || ''
              });
            });
          });
        }
        
        setTimeout(() => {
          const showFullBtn = document.getElementById('show-full-extracted-btn');
          if (showFullBtn) {
            let textAreaVisible = false;
            let textAreaElement = null;
            
            showFullBtn.addEventListener('click', () => {
              if (!textAreaVisible) {
                textAreaElement = document.createElement('textarea');
                let cleanText = text;
                cleanText = cleanText.replace(/---TOP_OF_PAGE---/g, '');
                cleanText = cleanText.replace(/---PAGE_BREAK---/g, '');
                cleanText = cleanText.replace(/\n\s*\n\s*\n/g, '\n\n');
                textAreaElement.value = cleanText.trim();
                textAreaElement.style.width = '100%';
                textAreaElement.style.height = '400px';
                textAreaElement.style.marginTop = '10px';
                textAreaElement.className = 'border rounded p-2 text-sm';
                pdfUploadSection.appendChild(textAreaElement);
                showFullBtn.textContent = 'Hide Extracted Text';
                textAreaVisible = true;
              } else {
                if (textAreaElement) {
                  textAreaElement.remove();
                }
                showFullBtn.textContent = 'Show Full Extracted Text';
                textAreaVisible = false;
              }
            });
          }
        }, 0);
        
      } catch (err) {
        console.error('PDF extraction failed:', err);
        pdfUploadStatus.style.color = '#ff6b6b';
        pdfUploadStatus.textContent = `Error: ${err.message}`;
      }
      
      pdfUploadInput.value = '';
    });
  }

  // Export Source Logic (for Hosting)
  const exportSourceBtn = document.getElementById('export-source-btn');
  if (exportSourceBtn) {
      exportSourceBtn.addEventListener('click', () => {
          if(!confirm("This will download 'monsters.json' and 'items.json' with your custom changes merged in.\n\nTo share your edits permanently, replace the files in your 'src' folder with these new ones before uploading to a host (e.g. GitHub Pages).")) return;

          // 1. Prepare Monsters
          const deleted = getDeletedItems();
          const customs = getCustomMonsters();
          // Remove deleted from built-ins
          const activeBuiltIns = monsters.filter(m => !deleted.includes(m.name));
          // Remove built-ins that are overridden by customs (same name)
          const nonOverriddenBuiltIns = activeBuiltIns.filter(m => !customs.some(c => c.name === m.name));
          // Merge
          const finalMonsters = [...nonOverriddenBuiltIns, ...customs].map(m => {
             // Check for custom image
             const customImg = localStorage.getItem(`monster_image_${m.name}`);
             if (customImg) {
                 return { ...m, image: customImg };
             }
             return m;
          });
          
          // Sort alphabetically
          finalMonsters.sort((a, b) => a.name.localeCompare(b.name));

          // 2. Prepare Items
          const customItems = getCustomItems();
          const activeBuiltInItems = items.filter(i => !deleted.includes(i.name));
          const nonOverriddenItems = activeBuiltInItems.filter(i => !customItems.some(c => c.name === i.name));
          const finalItems = [...nonOverriddenItems, ...customItems].map(i => {
              const customImg = localStorage.getItem(`item_image_${i.name}`);
              if (customImg) {
                  return { ...i, image: customImg };
              }
              return i;
          });
          finalItems.sort((a, b) => a.name.localeCompare(b.name));

          // 3. Download monsters.json
          const mBlob = new Blob([JSON.stringify(finalMonsters, null, 2)], { type: 'application/json' });
          const mUrl = URL.createObjectURL(mBlob);
          const a = document.createElement('a');
          a.href = mUrl;
          a.download = 'monsters.json';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(mUrl);

          // 4. Download items.json (slight delay to ensure both download)
          setTimeout(() => {
              const iBlob = new Blob([JSON.stringify(finalItems, null, 2)], { type: 'application/json' });
              const iUrl = URL.createObjectURL(iBlob);
              const a2 = document.createElement('a');
              a2.href = iUrl;
              a2.download = 'items.json';
              document.body.appendChild(a2);
              a2.click();
              document.body.removeChild(a2);
              URL.revokeObjectURL(iUrl);
          }, 500);
      });
  }

  const dragHandle = document.getElementById('drag-handle');
  
  // Dragging Logic
  let isDragging = false;
  let startX, startY;
  let initialLeft, initialTop;
  let animationFrameId = null;

  const getStoredPosition = () => {
      try {
          const stored = localStorage.getItem('dnd_extension_popover_pos');
          if (stored) return JSON.parse(stored);
      } catch (e) {}
      return { left: 200, top: 100 };
  };

  dragHandle.style.touchAction = 'none';
  dragHandle.style.cursor = 'grab';

  // Construct canonical URL once to prevent reload loops
  // We must strip OBR-injected parameters (like obrref) and only keep our own
  // searchParams is already defined at top of setup function
  const mode = searchParams.get('mode');
  const targetItemId = searchParams.get('itemId');
  
  let popoverUrl = '/index.html?mode=' + (mode || 'popover');
  if (targetItemId) {
      popoverUrl += '&itemId=' + targetItemId;
  }
  if (spawnPosition) {
      popoverUrl += `&spawnX=${spawnPosition.x}&spawnY=${spawnPosition.y}`;
  }

  dragHandle.addEventListener('pointerdown', (e) => {
      isDragging = true;
      try {
        dragHandle.setPointerCapture(e.pointerId);
      } catch (err) {
        console.warn("Failed to set pointer capture", err);
      }
      startX = e.screenX;
      startY = e.screenY;
      
      const stored = getStoredPosition();
      initialLeft = stored.left;
      initialTop = stored.top;
      
      dragHandle.style.background = '#555';
      dragHandle.style.cursor = 'grabbing';
  });

  dragHandle.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      
      // Use requestAnimationFrame to throttle updates and prevent lag
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      
      animationFrameId = requestAnimationFrame(() => {
          const deltaX = e.screenX - startX;
          const deltaY = e.screenY - startY;
          
          const newLeft = initialLeft + deltaX;
          const newTop = initialTop + deltaY;
          
          OBR.popover.open({
              id: 'dnd-monster-search-popover',
              width: 400,
              height: 600,
              url: popoverUrl, 
              anchorReference: "POSITION",
              anchorPosition: { left: newLeft, top: newTop }
          }).catch(e => console.error("Error moving popover:", e));
      });
  });

  dragHandle.addEventListener('pointerup', (e) => {
      if (isDragging) {
          isDragging = false;
          dragHandle.releasePointerCapture(e.pointerId);
          dragHandle.style.background = '#333';
          dragHandle.style.cursor = 'grab';
          
          if (animationFrameId) cancelAnimationFrame(animationFrameId);

          const deltaX = e.screenX - startX;
          const deltaY = e.screenY - startY;
          const finalLeft = initialLeft + deltaX;
          const finalTop = initialTop + deltaY;
          
          localStorage.setItem('dnd_extension_popover_pos', JSON.stringify({ left: finalLeft, top: finalTop }));
      }
  });

  // Tab Logic
  const switchTab = (tab) => {
      activeTab = tab;
      
      // Reset all tabs (only if they exist)
      if (tabMonsters) {
          tabMonsters.style.background = '#f0f0f0';
          tabMonsters.style.fontWeight = 'normal';
      }
      tabItems.style.background = '#f0f0f0';
      tabItems.style.fontWeight = 'normal';
      tabSpells.style.background = '#f0f0f0';
      tabSpells.style.fontWeight = 'normal';
      if (tabCustom) {
          tabCustom.style.background = '#f0f0f0';
          tabCustom.style.fontWeight = 'normal';
      }
      
      if (monsterFilters) monsterFilters.style.display = 'none';
      if (globalSettings) globalSettings.style.display = 'none';
      spellTools.style.display = 'none';
      if (randomBtn) randomBtn.style.display = 'none';

      if (tab === 'monsters' && tabMonsters) {
          tabMonsters.style.background = '#ddd';
          tabMonsters.style.fontWeight = 'bold';
          if (monsterFilters) monsterFilters.style.display = 'flex';
          if (globalSettings) globalSettings.style.display = 'flex';
          input.placeholder = "Search monsters (e.g. Goblin)...";
      } else if (tab === 'items') {
          tabItems.style.background = '#ddd';
          tabItems.style.fontWeight = 'bold';
          if (globalSettings) globalSettings.style.display = 'flex';
          if (randomBtn) randomBtn.style.display = 'block';
          input.placeholder = "Search items (e.g. Sword)...";
      } else if (tab === 'spells') {
          tabSpells.style.background = '#ddd';
          tabSpells.style.fontWeight = 'bold';
          spellTools.style.display = 'flex';
          input.placeholder = "Search spells (e.g. Fireball)...";
      } else if (tab === 'custom' && tabCustom) {
          tabCustom.style.background = '#ddd';
          tabCustom.style.fontWeight = 'bold';
          input.placeholder = "Search custom entries...";
      }
      renderResults(input.value);
  };

  if (tabMonsters) tabMonsters.addEventListener('click', () => switchTab('monsters'));
  tabItems.addEventListener('click', () => switchTab('items'));
  tabSpells.addEventListener('click', () => switchTab('spells'));
  if (tabCustom) tabCustom.addEventListener('click', () => switchTab('custom'));

  // Random Item Logic
  if (randomBtn) {
      randomBtn.addEventListener('click', () => {
          const deleted = getDeletedItems();
          const customs = getCustomItems();
          const builtIns = items.filter(i => !customs.some(c => c.name === i.name));
          const allItems = [...customs, ...builtIns].filter(i => !deleted.includes(i.name));

          if (allItems && allItems.length > 0) {
              const randomItem = allItems[Math.floor(Math.random() * allItems.length)];
              showStats(randomItem);
          } else {
              alert("No items found to pick from!");
          }
      });
  }

  backBtn.addEventListener('click', () => {
    statsView.style.display = 'none';
    searchView.style.display = 'flex';
  });

  // --- New Image Edit Event Listeners (Event Delegation) ---
  // Toggle image edit panel
  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'toggle-image-edit') {
      const panel = document.getElementById('image-edit-panel');
      if (!panel) return;
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      
      if (panel.style.display === 'block') {
        const entryName = statsContent.dataset.entryName;
        const isItem = statsContent.dataset.isItem === 'true';
        const isSpell = statsContent.dataset.isSpell === 'true';
        
        const imgKey = isItem ? `item_image_${entryName}` : (isSpell ? `spell_image_${entryName}` : `monster_image_${entryName}`);
        const currentImg = localStorage.getItem(imgKey);
        
        let usedImagesForEntry = [];
        if (currentImg) {
          usedImagesForEntry.push(currentImg);
        }
        
        const entryHistory = getUsedImagesForEntry(entryName);
        entryHistory.forEach(url => {
          if (!usedImagesForEntry.includes(url)) {
            usedImagesForEntry.push(url);
          }
        });
        
        const statsUsedImages = document.getElementById('stats-used-images');
        if (statsUsedImages) {
          statsUsedImages.innerHTML = usedImagesForEntry.map((url, idx) => `
            <img src="${url}" data-url="${url}" style="width: 50px; height: 50px; object-fit: contain; border: 2px solid ${idx === 0 && currentImg === url ? '#2196F3' : '#ddd'}; border-radius: 4px; cursor: pointer; background: #333;" title="Click to use this image" />
          `).join('');
        }
      }
    }
  });

  // Click on used images in stats panel
  document.addEventListener('click', (e) => {
    const img = e.target.closest('#stats-used-images img');
    if (img) {
      const urlInput = document.getElementById('new-image-url');
      if (urlInput) {
        urlInput.value = img.dataset.url;
      }
    }
  });

  // Reset image button
  document.addEventListener('click', async (e) => {
    if (e.target && e.target.id === 'reset-this-image') {
      const entryName = statsContent.dataset.entryName;
      const isItem = statsContent.dataset.isItem === 'true';
      
      const key = isItem ? `item_image_${entryName}` : `monster_image_${entryName}`;
      
      if (localStorage.getItem(key)) {
        if (confirm(`Reset custom image for "${entryName}"? This will revert to the default image.`)) {
          localStorage.removeItem(key);
          saveToBackend();
          alert(`Custom image for "${entryName}" removed.`);
        }
      } else {
        alert(`No custom image saved for "${entryName}".`);
      }
    }
  });

  // Clear image cache button
  document.addEventListener('click', async (e) => {
    if (e.target && e.target.id === 'clear-image-cache') {
      if (confirm('Delete all custom monster images from storage? This cannot be undone.')) {
        let count = 0;
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key.startsWith('monster_image_')) {
            keys.push(key);
          }
        }
        keys.forEach(k => {
          localStorage.removeItem(k);
          count++;
        });
        saveToBackend();
        alert(`Cleared ${count} saved images.`);
      }
    }
  });

  // Library button click
  document.addEventListener('click', async (e) => {
    if (e.target && e.target.id === 'library-btn') {
      try {
        if (!OBR || !OBR.assets) {
          throw new Error("OBR Assets API is not available.");
        }
        const result = await OBR.assets.downloadImages(false, '', 'CHARACTER');
        if (result && result.length > 0) {
          const img = result[0];
          console.log("Selected library image:", img);
          const urlInput = document.getElementById('new-image-url');
          if (urlInput && img.image && img.image.url) {
            urlInput.value = img.image.url;
            if (img.image.mime) {
              urlInput.dataset.mime = img.image.mime;
            }
          }
        }
      } catch (err) {
        console.error("Failed to open library (Full Error):", JSON.stringify(err, null, 2));
        const errName = err.name || (err.error && err.error.name) || '';
        const errMsg = err.message || (err.error && err.error.message) || (typeof err === 'object' ? JSON.stringify(err) : String(err));
        alert(`Could not open library.\nDetails: ${errMsg}\n\nPlease ensure you are running inside Owlbear Rodeo as a GM.`);
      }
    }
  });

  // Save image button click
  document.addEventListener('click', async (e) => {
    if (e.target && e.target.id === 'save-new-image') {
      const entryName = statsContent.dataset.entryName;
      const fullData = JSON.parse(statsContent.dataset.fullData);
      const itemId = statsContent.dataset.itemId || null;
      const urlInput = document.getElementById('new-image-url');
      const panel = document.getElementById('image-edit-panel');
      const saveImgBtn = document.getElementById('save-new-image');
      
      if (!urlInput) return;
      
      let newImage = urlInput.value.trim();
      
      // Parse Google image URLs
      if (newImage.includes('google.com') && newImage.includes('imgurl=')) {
        try {
          const urlObj = new URL(newImage);
          const imgUrl = urlObj.searchParams.get('imgurl');
          if (imgUrl) {
            console.log("Detected Google Image URL, extracted:", imgUrl);
            newImage = decodeURIComponent(imgUrl);
          }
        } catch (err) {
          console.warn("Failed to parse Google Image URL:", err);
        }
      }
      
      // Parse OBR JSON
      if (newImage.startsWith('{')) {
        try {
          const parsed = JSON.parse(newImage);
          console.log("Detected JSON input, attempting to extract image URL...", parsed);
          let extractedUrl = null;
          let extractedMime = null;
          
          if (parsed.items && parsed.items.shared) {
            const itemKeys = Object.keys(parsed.items.shared);
            if (itemKeys.length > 0) {
              const firstItem = parsed.items.shared[itemKeys[0]];
              if (firstItem.image && firstItem.image.url) {
                extractedUrl = firstItem.image.url;
                if (firstItem.image.mime) extractedMime = firstItem.image.mime;
              }
            }
          }
          
          if (!extractedUrl && parsed.image && parsed.image.url) {
            extractedUrl = parsed.image.url;
            if (parsed.image.mime) extractedMime = parsed.image.mime;
          }
          
          if (extractedUrl) {
            newImage = extractedUrl;
            if (extractedMime) {
              urlInput.dataset.mime = extractedMime;
            }
            console.log("Successfully extracted URL:", newImage);
          }
        } catch (err) {
          console.warn("Input looked like JSON but failed to parse/extract:", err);
        }
      }
      
      newImage = newImage.replace(/`/g, '').trim();
      
      const saveAndApply = async (imgSrc, isRetry = false) => {
        try {
          if (imgSrc.trim().startsWith('{') || imgSrc.includes('"items":')) {
            throw new Error("Invalid image URL. It looks like you pasted a raw JSON object. Please try extracting just the URL or use 'Select from Library'.");
          }
          
          try {
            localStorage.setItem(`monster_image_${entryName}`, imgSrc);
            addUsedImageForEntry(entryName, imgSrc);
            saveToBackend();
          } catch (storageErr) {
            console.warn("Failed to save image to localStorage (Quota Exceeded?):", storageErr);
          }
          
          if (itemId) {
            const items = await OBR.scene.items.getItems([itemId]);
            if (items.length > 0) {
              const oldItem = items[0];
              
              if (oldItem.image.url === imgSrc) {
                alert("The selected image is identical to the current one.");
                return;
              }
              
              const mime = urlInput.dataset.mime || 
                          (imgSrc.startsWith('data:image/jpeg') ? 'image/jpeg' : 
                          (imgSrc.startsWith('data:image/webp') ? 'image/webp' : 
                          (imgSrc.startsWith('data:image/png') ? 'image/png' : 'image/png')));
              
              let squares = 1;
              if (fullData.type) {
                const lowerType = fullData.type.toLowerCase();
                if (lowerType.includes('gargantuan')) squares = 4;
                else if (lowerType.includes('huge')) squares = 3;
                else if (lowerType.includes('large')) squares = 2;
              }
              
              let imgWidth, imgHeight, imgDpi;
              const dims = await getImageDimensions(imgSrc);
              if (dims && dims.width && dims.height) {
                imgWidth = dims.width;
                imgHeight = dims.height;
                const maxDim = Math.max(imgWidth, imgHeight);
                imgDpi = maxDim / squares;
              } else {
                imgWidth = squares * 150;
                imgHeight = squares * 150;
                imgDpi = 150;
              }
              
              const newItemId = `monster-${Date.now()}-${Math.floor(Math.random()*1000)}`;
              const newItem = {
                ...oldItem,
                id: newItemId,
                locked: false,
                disableHit: false,
                image: {
                  ...oldItem.image,
                  url: imgSrc,
                  mime: mime,
                  width: imgWidth,
                  height: imgHeight
                },
                grid: { dpi: imgDpi, offset: { x: 0, y: 0 } },
                scale: { x: 1, y: 1 }
              };
              
              if (!newItem.type) newItem.type = 'IMAGE';
              if (!newItem.scale) newItem.scale = { x: 1, y: 1 };
              if (!newItem.position) newItem.position = { x: 0, y: 0 };
              
              console.log("Replacing item:", oldItem.id, "with", newItem.id);
              
              await OBR.scene.items.addItems([newItem]);
              await OBR.scene.items.deleteItems([itemId]);
              
              showStats(fullData, newItemId);
              return;
            }
          }
          
          alert('Image saved! Future adds of this monster will use this image.');
          if (panel) panel.style.display = 'none';
        } catch (err) {
          console.error("Error saving image (FULL LOG):", JSON.stringify(err, null, 2));
          const errMsg = err.message || (err.error && err.error.message) || (typeof err === 'object' ? JSON.stringify(err) : String(err));
          if (!isRetry) { 
            alert("Failed to save image. " + errMsg + "\n\nSee console (F12) for full error details.");
          }
        }
      };
      
      if (newImage) {
        saveImgBtn.disabled = true;
        saveImgBtn.innerText = "Processing...";
        try {
          let finalImage = await processAndRemoveBackground(newImage);
          try {
            saveImgBtn.innerText = "Verifying...";
            let folder = 'monsters';
            if (fullData && (fullData.rarity || fullData.type === 'Weapon' || fullData.type === 'Armor' || fullData.type === 'Potion')) {
              folder = 'items';
            }
            finalImage = await ensureShortImageUrl(finalImage, entryName, folder);
          } catch (uploadErr) {
            console.error("Image optimization failed:", uploadErr);
          }
          await saveAndApply(finalImage);
        } catch (err) {
          console.error("Processing failed, using original", err);
          try {
            let folder = 'monsters';
            if (fullData && (fullData.rarity || fullData.type === 'Weapon' || fullData.type === 'Armor' || fullData.type === 'Potion')) {
              folder = 'items';
            }
            newImage = await ensureShortImageUrl(newImage, entryName, folder);
          } catch (ignore) {}
          await saveAndApply(newImage);
        } finally {
          saveImgBtn.disabled = false;
          saveImgBtn.innerText = "Save & Apply";
        }
      } else {
        alert("Please select an image from the library or paste a URL.");
      }
    }
  });

  const showStats = (data, itemId) => {
    const isSpell = data.level !== undefined || data.school !== undefined || (data.aoe !== undefined);
    const isItem = !isSpell && (!data.hp && !data.ac);
    const isMonster = !isSpell && !isItem;
    
    // Check if trying to show monster stats but not GM
    if (isMonster && !isGM) {
        alert("Only the GM can view monster stats!");
        return;
    }
    
    searchView.style.display = 'none';
    statsView.style.display = 'block';
    
    const entryName = data.name.split('\n')[0];
    // Store data in data attributes
    statsContent.dataset.entryName = entryName;
    statsContent.dataset.isItem = isItem;
    statsContent.dataset.isSpell = isSpell;
    statsContent.dataset.itemId = itemId || '';
    // Also store the full data as a JSON string (for quick access)
    statsContent.dataset.fullData = JSON.stringify(data);

    // Try to find fresh data from the library
    let libraryData = null;
    let descriptionToUse = data.description;
    
    if (isSpell) {
        const customSpells = getCustomSpells();
        libraryData = customSpells.find(s => s.name === data.name);
        
        if (!libraryData && typeof SPELL_DATA !== 'undefined') {
            libraryData = SPELL_DATA[data.name];
            if (libraryData) libraryData.name = data.name; // Ensure name is present
        }
        
        if (libraryData) {
            descriptionToUse = libraryData.description;
            data = { ...data, ...libraryData };
        }
    } else if (isItem) {
        // Check custom items first
        const customItems = getCustomItems();
        libraryData = customItems.find(i => i.name === data.name);
        
        // Fallback to built-in items
        if (!libraryData) {
            libraryData = items.find(i => i.name === data.name);
        }

        if (libraryData) {
            descriptionToUse = libraryData.description;
            data = { ...data, ...libraryData }; // Merge to get flavor/details
        }
    } else {
        // Check custom monsters first
        const customMonsters = getCustomMonsters();
        libraryData = customMonsters.find(m => m.name === data.name);
        
        // Fallback to built-in monsters
        if (!libraryData) {
             libraryData = monsters.find(m => m.name === data.name);
        }

        if (libraryData) {
            descriptionToUse = libraryData.description;
            data = { ...data, ...libraryData };
        }
    }
    
    // Format description text (preserve newlines)
    const formattedDesc = descriptionToUse ? descriptionToUse.replace(/\n/g, '<br>') : 'No description available.';
    
    // Extract globals for manual spells (DC, To Hit) from text
    const text = descriptionToUse ? descriptionToUse.replace(/\r\n/g, '\n') : '';
    const globalSaveDC = (text.match(/spell save DC (\d+)/i) || [])[1];
    const globalToHit = (text.match(/([+-]\d+)\s*to\s*hit\s*with\s*spell/i) || [])[1];

    // Check if we have an item ID to allow editing
    let statsInputs = '';
    
    if (isSpell) {
        statsInputs = `
            <div style="margin-bottom: 5px; font-size: 0.9em; color: #555;">
                <strong>Level ${data.level} ${data.school || 'Spell'}</strong>
            </div>
            ${data.aoe ? `
            <div style="margin-bottom: 5px; padding: 5px; background: #e8f5e9; border: 1px solid #c8e6c9; border-radius: 4px;">
                <strong>AoE:</strong> ${data.aoe.size}ft ${data.aoe.type}
            </div>` : ''}
            
            <button id="cast-spell-btn" style="width: 100%; margin-bottom: 5px; background-color: #673ab7; color: white; border: none; padding: 8px; border-radius: 4px; cursor: pointer; font-weight: bold;">Cast / Place Template</button>
            <button id="edit-btn" style="width: 100%; margin-bottom: 5px; background-color: #2196F3; color: white; border: none; padding: 8px; border-radius: 4px; cursor: pointer;">Edit / Rename</button>
            <button id="share-description-btn" style="width: 100%; margin-bottom: 5px; background-color: #FF9800; color: white; border: none; padding: 8px; border-radius: 4px; cursor: pointer;">Share to Map (Note)</button>
            <button id="delete-item-btn" style="width: 100%; margin-bottom: 10px; background-color: #d32f2f; color: white; border: none; padding: 8px; border-radius: 4px; cursor: pointer;">Delete from List</button>
        `;
    } else if (isItem) {
        statsInputs = `
            <div style="margin-bottom: 5px; font-size: 0.9em; color: #555;">
                <strong>${data.type || 'Unknown Type'}</strong>
            </div>
            <button id="edit-btn" style="width: 100%; margin-bottom: 5px; background-color: #2196F3; color: white; border: none; padding: 8px; border-radius: 4px; cursor: pointer;">Edit / Rename</button>
            <button id="add-item-to-map-btn" style="width: 100%; margin-bottom: 5px; background-color: #4CAF50; color: white; border: none; padding: 8px; border-radius: 4px; cursor: pointer;">Add to Map</button>
            <button id="share-description-btn" style="width: 100%; margin-bottom: 5px; background-color: #FF9800; color: white; border: none; padding: 8px; border-radius: 4px; cursor: pointer;">Share to Map (Note)</button>
            <button id="delete-item-btn" style="width: 100%; margin-bottom: 10px; background-color: #d32f2f; color: white; border: none; padding: 8px; border-radius: 4px; cursor: pointer;">Delete from List</button>
        `;
    } else {
        statsInputs = itemId 
            ? `<div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 5px; padding: 8px; background: #f5f5f5; border-radius: 6px; color: #333;">
                 <div style="display: flex; align-items: center; gap: 8px;">
                   <strong style="width: 30px;">HP:</strong> 
                   <button id="hp-minus-btn" style="padding: 2px 8px; cursor: pointer; background: #eee; border: 1px solid #ccc; border-radius: 3px;">-</button>
                   <input type="number" id="hp-input" value="${data.hp}" style="width: 50px; text-align: center; border: 1px solid #ccc; border-radius: 3px;">
                   <button id="hp-plus-btn" style="padding: 2px 8px; cursor: pointer; background: #eee; border: 1px solid #ccc; border-radius: 3px;">+</button>
                   <button id="hp-reset-btn" style="padding: 2px 5px; cursor: pointer; background: #fff; border: 1px solid #ccc; border-radius: 3px; font-size: 0.8em;" title="Reset HP to default">↺</button>
                 </div>
                 <div style="display: flex; align-items: center; gap: 8px;">
                   <strong style="width: 30px;">AC:</strong> 
                   <button id="ac-minus-btn" style="padding: 2px 8px; cursor: pointer; background: #eee; border: 1px solid #ccc; border-radius: 3px;">-</button>
                   <input type="number" id="ac-input" value="${data.ac}" style="width: 50px; text-align: center; border: 1px solid #ccc; border-radius: 3px;">
                   <button id="ac-plus-btn" style="padding: 2px 8px; cursor: pointer; background: #eee; border: 1px solid #ccc; border-radius: 3px;">+</button>
                   <button id="ac-reset-btn" style="padding: 2px 5px; cursor: pointer; background: #fff; border: 1px solid #ccc; border-radius: 3px; font-size: 0.8em;" title="Reset AC to default">↺</button>
                 </div>
                 <div style="display: flex; align-items: center; gap: 8px; margin-top: 2px; font-size: 0.85em;">
                   <span>Adjustment Amount:</span>
                   <input type="number" id="stat-adjust-amount" value="1" style="width: 40px; border: 1px solid #ccc; border-radius: 3px; padding: 2px;">
                 </div>
                 <button id="update-stats-btn" data-id="${itemId}" style="margin-top: 5px; padding: 6px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">Apply Changes</button>
                 <button id="share-description-btn" style="width: 100%; margin-top: 5px; background-color: #FF9800; color: white; border: none; padding: 6px; border-radius: 4px; cursor: pointer;">Share to Map (Note)</button>
                 <button id="add-to-scene-btn" style="width: 100%; margin-top: 5px; background-color: #4CAF50; color: white; border: none; padding: 6px; border-radius: 4px; cursor: pointer;">Add Another to Scene</button>
                 <button id="delete-item-btn" style="width: 100%; margin-top: 5px; background-color: #d32f2f; color: white; border: none; padding: 8px; border-radius: 4px; cursor: pointer;">Delete from List</button>
               </div>`
            : `<button id="edit-btn" style="width: 100%; margin-bottom: 5px; background-color: #2196F3; color: white; border: none; padding: 8px; border-radius: 4px; cursor: pointer;">Edit / Rename</button>
               <button id="add-to-scene-btn" style="width: 100%; margin-bottom: 5px; background-color: #4CAF50; color: white; border: none; padding: 8px; border-radius: 4px; cursor: pointer;">Add to Scene</button>
               <button id="share-description-btn" style="width: 100%; margin-bottom: 5px; background-color: #FF9800; color: white; border: none; padding: 8px; border-radius: 4px; cursor: pointer;">Share to Map (Note)</button>
               <button id="delete-item-btn" style="width: 100%; margin-bottom: 10px; background-color: #d32f2f; color: white; border: none; padding: 8px; border-radius: 4px; cursor: pointer;">Delete from List</button>
               <div style="margin-top: 5px;"><strong>HP:</strong> ${data.hp} | <strong>AC:</strong> ${data.ac}</div>`;
    }

    // Image Edit UI
    const imageEditHtml = `
      <div style="margin-top: 10px; border-top: 1px solid #ccc; padding-top: 10px;">
        <button id="toggle-image-edit" style="width: 100%;">Change Image</button>
        <div id="image-edit-panel" style="display: none; margin-top: 5px; padding: 5px; background: #f0f0f0; border-radius: 4px; color: black;">
            <p style="margin: 0 0 5px 0; font-size: 0.9em;">Update image for all future instances:</p>
            <button id="library-btn" style="width: 100%; margin-bottom: 5px; background-color: #6200ea; color: white; border: none; padding: 8px; border-radius: 3px; cursor: pointer;">Select from Library / Upload</button>
            <div style="text-align: center; margin: 5px 0; font-size: 0.8em;">- OR -</div>
            <input type="text" id="new-image-url" placeholder="Paste Image URL" style="width: 100%; box-sizing: border-box; margin-bottom: 5px;">
            <div style="margin-top: 10px;">
                <div style="font-size: 0.9em; font-weight: bold; margin-bottom: 5px;">Used Images:</div>
                <div id="stats-used-images" style="display: flex; gap: 5px; overflow-x: auto; padding: 5px; border: 1px solid #ddd; border-radius: 4px; min-height: 60px; background: white;"></div>
            </div>
            <button id="save-new-image" style="width: 100%; margin-top: 10px; margin-bottom: 5px;">Save & Apply</button>
            <div style="display: flex; gap: 5px;">
                <button id="reset-this-image" style="flex: 1; background: #f57c00; color: white; border: none; padding: 5px; border-radius: 3px; cursor: pointer;" title="Remove custom image for this entry only">Reset This Image</button>
                <button id="clear-image-cache" style="flex: 1; background: #d33; color: white; border: none; padding: 5px; border-radius: 3px; cursor: pointer;" title="Delete ALL custom monster images">Clear All Images</button>
            </div>
        </div>
      </div>
    `;

    // Parse actions
    let currentActions = parseMonsterActions(descriptionToUse);
    let quickCastAction = null; // For manual "Quick Cast"
    
    // Prefer structured stats if available, otherwise parse description
    let abilities = [];
    if (data.stats && Object.keys(data.stats).length > 0) {
        abilities = parseStatsObject(data.stats);
    } else {
        abilities = parseAbilities(descriptionToUse);
    }

    const saves = parseSavingThrows(descriptionToUse);

    const abilitiesHtml = abilities.length > 0 ? `
        <div style="display: flex; justify-content: space-between; margin: 10px 0; background: #eee; color: #222; padding: 5px; border-radius: 5px;">
            ${abilities.map(ab => `
                <div style="text-align: center; display: flex; flex-direction: column; align-items: center;">
                    <div style="font-weight: bold; font-size: 0.8em;">${ab.name}</div>
                    <div style="font-size: 0.9em;">${ab.score}</div>
                    <button class="roll-btn" data-type="ability" data-name="${ab.name}" data-mod="${ab.mod}" style="font-size: 0.8em; min-width: 30px; padding: 1px 0; border-radius: 3px; border: 1px solid #ccc; cursor: pointer; background: #fff; color: #222;">
                        ${ab.mod >= 0 ? '+' : ''}${ab.mod}
                    </button>
                </div>
            `).join('')}
        </div>
    ` : '';

    const savesHtml = saves.length > 0 ? `
        <div style="margin: 5px 0;">
            <strong>Saving Throws:</strong> 
            ${saves.map(save => `
                <button class="roll-btn" data-type="save-check" data-name="${save.name}" data-mod="${save.mod}" style="margin-right: 5px; font-size: 0.9em; padding: 2px 5px; cursor: pointer; border: 1px solid #ccc; border-radius: 3px; background: #f0f0f0; color: #222;">
                    ${save.name} ${save.mod >= 0 ? '+' : ''}${save.mod}
                </button>
            `).join('')}
        </div>
    ` : '';
    
    // Manual Spell Search HTML
    const manualSpellHtml = `
        <div style="margin: 10px 0; padding: 10px; background: #e8eaf6; border-radius: 5px; border: 1px solid #c5cae9;">
            <div style="font-weight: bold; margin-bottom: 5px; color: #3f51b5; font-size: 0.9em;">Quick Cast</div>
            <div style="position: relative;">
                <input type="text" id="manual-spell-input" placeholder="Search spell library (e.g. Fireball)..." autocomplete="off" style="width: 100%; padding: 6px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">
                <div id="manual-spell-results" style="display: none; position: absolute; top: 100%; left: 0; right: 0; max-height: 200px; overflow-y: auto; background: white; color: black; border: 1px solid #999; z-index: 100; box-shadow: 0 4px 8px rgba(0,0,0,0.2);"></div>
            </div>
            <div id="quick-cast-container" style="margin-top: 10px;"></div>
        </div>
    `;

    // Helper to render action card
    const renderCard = (action, index) => `
        <div style="margin-bottom: 8px; padding: 5px; background: #f9f9f9; border-radius: 4px; color: black;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div style="font-weight: bold;">${action.name}</div>
                ${action.save ? `<button class="roll-btn" data-type="save" data-index="${index}" style="font-size: 0.8em; color: #d00; font-weight: bold; background: none; border: 1px solid #d00; border-radius: 4px; padding: 2px 5px; cursor: pointer;">DC ${action.save.dc} ${action.save.stat}</button>` : ''}
            </div>
            
            ${(action.isTrait || (!action.toHit && !action.save && action.damages.length === 0 && action.spells.length === 0)) ? `<div style="font-size: 0.9em; margin: 4px 0; color: #333; max-height: 100px; overflow-y: auto;">${action.originalText.replace(/\n/g, ' ')}</div>` : ''}

            <div style="font-size: 0.9em; margin-bottom: 4px; color: #555;">
                ${action.damages.length > 0 ? action.damages.map(d => d.type).join(' + ') : ((action.isTrait || (!action.toHit && !action.save && action.damages.length === 0 && action.spells.length === 0)) ? '' : 'Effect')}
            </div>
            <div style="display: flex; gap: 5px; flex-wrap: wrap;">
                ${action.toHit ? `
                <button class="roll-btn" data-type="attack" data-index="${index}">
                    Attack (+${action.toHit})
                </button>` : ''}
                
                ${action.damages.map((dmg, dmgIndex) => `
                <button class="roll-btn" data-type="damage" data-index="${index}" data-damage-index="${dmgIndex}">
                    ${dmg.dice} ${dmg.type}
                </button>
                `).join('')}

                ${action.spells.length > 0 ? action.spells.map((spell, sIndex) => `
                <div style="display: inline-flex; align-items: center; margin-right: 5px; margin-bottom: 2px;">
                    <button class="roll-btn" data-type="spell" data-index="${index}" data-spell-index="${sIndex}" style="background-color: #e6f3ff; border: 1px solid #007bff; color: #0056b3; border-radius: ${spell.aoe ? '3px 0 0 3px' : '3px'}; border-right: ${spell.aoe ? 'none' : '1px solid #007bff'};">
                        ${spell.name} ${spell.dice ? `(${spell.dice})` : (spell.label ? `[${spell.label}]` : '')}
                    </button>
                    ${spell.aoe ? `
                    <button class="roll-btn" data-type="spell-aoe" data-index="${index}" data-spell-index="${sIndex}" title="Place ${spell.aoe.size}ft ${spell.aoe.type}" style="background-color: #fff3e0; border: 1px solid #ff9800; color: #e65100; padding: 1px 5px; border-radius: 0 3px 3px 0; cursor: pointer;">
                        📐
                    </button>
                    ` : ''}
                </div>
                `).join('') : ''}

                ${action.aoe ? `
                <button class="roll-btn" data-type="aoe-template" data-index="${index}" style="background-color: #fff3e0; border: 1px solid #ff9800; color: #e65100;">
                    📐 ${action.aoe.size}ft ${action.aoe.type}
                </button>` : ''}
            </div>
        </div>
    `;

    if (isSpell) {
        statsContent.innerHTML = `
          <h2>${data.name.split('\n')[0]}</h2>
          <div style="margin-bottom: 10px;">
            ${statsInputs}
            ${manualSpellHtml}
            <div id="actions-wrapper"></div>
          </div>
          <hr>
          <div style="white-space: pre-wrap; font-family: sans-serif;">${descriptionToUse || 'No details.'}</div>
          <p style="margin-top: 10px; font-size: 0.8em; color: #666;"><em>${data.source || 'Unknown Source'}</em></p>
        `;
    } else if (isItem) {
        let flavorHtml = '';
        let detailsHtml = '';
        
        if (data.flavor) {
            flavorHtml = `<div style="font-style: italic; margin-bottom: 10px; color: #444;">${data.flavor.replace(/\n/g, '<br>')}</div>`;
        }
        
        if (data.details) {
            detailsHtml = `<div style="white-space: pre-wrap; font-family: sans-serif;">${data.details}</div>`;
        } else {
            detailsHtml = `<div style="white-space: pre-wrap; font-family: sans-serif;">${descriptionToUse || 'No details.'}</div>`;
        }

        statsContent.innerHTML = `
          <h2>${data.name.split('\n')[0]}</h2>
          <div style="margin-bottom: 10px;">
            ${statsInputs}
            ${imageEditHtml}
            ${manualSpellHtml}
            <div id="actions-wrapper"></div>
          </div>
          <hr>
          ${flavorHtml}
          <hr>
          <h3 style="margin-bottom: 5px; display: flex; justify-content: space-between; align-items: center;">
            Details
            <button id="edit-description-btn" style="padding: 4px 8px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.8em;">Edit</button>
          </h3>
          <div id="details-display">${detailsHtml}</div>
          <div id="details-edit" style="display: none; margin-top: 10px;">
            <textarea id="description-textarea" rows="8" style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;">${descriptionToUse || ''}</textarea>
            <div style="margin-top: 8px; display: flex; gap: 8px;">
              <button id="save-description-btn" style="flex: 1; padding: 6px 12px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer;">Save</button>
              <button id="cancel-description-btn" style="flex: 1; padding: 6px 12px; background: #666; color: white; border: none; border-radius: 4px; cursor: pointer;">Cancel</button>
            </div>
          </div>
          <p style="margin-top: 10px; font-size: 0.8em; color: #666;"><em>${data.source || 'Unknown Source'}</em></p>
        `;
    } else {
        statsContent.innerHTML = `
          <h2>${data.name.split('\n')[0]}</h2>
          <div style="margin-bottom: 10px;">
            ${statsInputs}
            ${imageEditHtml}
            <p><strong>CR:</strong> ${data.cr || '?'}</p>
            ${abilitiesHtml}
            ${savesHtml}
            ${manualSpellHtml}
            <div id="actions-wrapper"></div>
          </div>
          <p><em>${data.source || 'Unknown Source'}</em></p>
          <div style="margin-bottom: 10px;">
            <button id="refresh-stats-btn" style="padding: 5px 10px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer;">
              🔄 Refresh Stats from Description
            </button>
          </div>
          <hr>
          <h3 style="margin-bottom: 5px; display: flex; justify-content: space-between; align-items: center;">
            Description
            <button id="edit-description-btn" style="padding: 4px 8px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.8em;">Edit</button>
          </h3>
          <div id="details-display" style="white-space: pre-wrap; font-family: monospace; background: #333; padding: 10px; border-radius: 5px;">
            ${descriptionToUse || 'No detailed stats available.'}
          </div>
          <div id="details-edit" style="display: none; margin-top: 10px;">
            <textarea id="description-textarea" rows="12" style="width: 100%; padding: 8px; border: 1px solid #444; border-radius: 4px; box-sizing: border-box; background: #2a2a2a; color: white;">${descriptionToUse || ''}</textarea>
            <div style="margin-top: 8px; display: flex; gap: 8px;">
              <button id="save-description-btn" style="flex: 1; padding: 6px 12px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer;">Save</button>
              <button id="cancel-description-btn" style="flex: 1; padding: 6px 12px; background: #666; color: white; border: none; border-radius: 4px; cursor: pointer;">Cancel</button>
            </div>
          </div>
        `;
    }

    // Description Edit Listeners
    const editDescBtn = document.getElementById('edit-description-btn');
    const detailsDisplay = document.getElementById('details-display');
    const detailsEdit = document.getElementById('details-edit');
    const descTextarea = document.getElementById('description-textarea');
    const saveDescBtn = document.getElementById('save-description-btn');
    const cancelDescBtn = document.getElementById('cancel-description-btn');
    
    if (editDescBtn) {
      editDescBtn.addEventListener('click', () => {
        detailsDisplay.style.display = 'none';
        detailsEdit.style.display = 'block';
        if (descTextarea) {
          descTextarea.focus();
        }
      });
    }
    
    if (cancelDescBtn) {
      cancelDescBtn.addEventListener('click', () => {
        detailsEdit.style.display = 'none';
        detailsDisplay.style.display = 'block';
        if (descTextarea) {
          descTextarea.value = descriptionToUse || '';
        }
      });
    }
    
    if (saveDescBtn) {
      saveDescBtn.addEventListener('click', async () => {
        if (!descTextarea) return;
        
        const newDesc = descTextarea.value;
        
        // Save to custom data
        let saved = false;
        
        if (isMonster) {
          const customMonsters = getCustomMonsters();
          let idx = customMonsters.findIndex(m => m.name === data.name);
          
          if (idx === -1) {
            // Create custom monster if not exists
            customMonsters.push({
              ...data,
              description: newDesc,
              source: 'Custom'
            });
            saved = true;
          } else {
            customMonsters[idx].description = newDesc;
            saved = true;
          }
          
          if (saved) {
            localStorage.setItem('dnd_extension_custom_monsters', JSON.stringify(customMonsters));
            saveToBackend();
          }
        } else if (isItem) {
          const customItems = getCustomItems();
          let idx = customItems.findIndex(i => i.name === data.name);
          
          if (idx === -1) {
            customItems.push({
              ...data,
              description: newDesc,
              source: 'Custom'
            });
            saved = true;
          } else {
            customItems[idx].description = newDesc;
            saved = true;
          }
          
          if (saved) {
            localStorage.setItem('dnd_extension_custom_items', JSON.stringify(customItems));
            saveToBackend();
          }
        } else if (isSpell) {
          const customSpells = getCustomSpells();
          let idx = customSpells.findIndex(s => s.name === data.name);
          
          if (idx === -1) {
            customSpells.push({
              ...data,
              description: newDesc,
              source: 'Custom'
            });
            saved = true;
          } else {
            customSpells[idx].description = newDesc;
            saved = true;
          }
          
          if (saved) {
            localStorage.setItem('dnd_extension_custom_spells', JSON.stringify(customSpells));
            saveToBackend();
          }
        }
        
        if (saved) {
          descriptionToUse = newDesc;
          
          // Re-render the display
          if (isItem || isSpell) {
            detailsHtml = `<div style="white-space: pre-wrap; font-family: sans-serif;">${newDesc || 'No details.'}</div>`;
            detailsDisplay.innerHTML = detailsHtml;
          } else {
            detailsDisplay.innerHTML = `<div style="white-space: pre-wrap; font-family: monospace; background: #333; padding: 10px; border-radius: 5px;">${newDesc || 'No detailed stats available.'}</div>`;
          }
          
          detailsEdit.style.display = 'none';
          detailsDisplay.style.display = 'block';
          alert('Description saved!');
        }
      });
    }

    // Refresh Stats Listener (for Monsters)
    if (!isSpell && !isItem) {
      const refreshBtn = document.getElementById('refresh-stats-btn');
      if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
          console.log("Refresh button clicked!");
          console.log("Description to use:", descriptionToUse);
          
          if (!confirm(`Refresh stats for ${data.name} using the description/stat block? This will update HP, AC, CR, and type!`)) {
            return;
          }
          
          const parsed = parseStatBlock(descriptionToUse || '');
          console.log("Parsed stat block:", parsed);
          
          let updated = false;
          const changes = [];
          
          const customs = getCustomMonsters();
          const idx = customs.findIndex(m => m.name === data.name);
          if (idx === -1) {
            alert("This is a built-in monster, not a custom one. Edit it to refresh stats!");
            return;
          }
          
          const monster = customs[idx];
          console.log("Current monster stats:", { hp: monster.hp, ac: monster.ac, cr: monster.cr, type: monster.type });
          
          if (parsed.hp !== undefined && parsed.hp !== monster.hp) {
            changes.push(`HP: ${monster.hp} → ${parsed.hp}`);
            monster.hp = parsed.hp;
            updated = true;
          }
          if (parsed.ac !== undefined && parsed.ac !== monster.ac) {
            changes.push(`AC: ${monster.ac} → ${parsed.ac}`);
            monster.ac = parsed.ac;
            updated = true;
          }
          if (parsed.cr && parsed.cr !== monster.cr) {
            changes.push(`CR: ${monster.cr} → ${parsed.cr}`);
            monster.cr = parsed.cr;
            updated = true;
          }
          if (parsed.type && parsed.type !== monster.type) {
            changes.push(`Type: ${monster.type} → ${parsed.type}`);
            monster.type = parsed.type;
            updated = true;
          }
          
          console.log("Changes detected:", changes);
          
          if (updated) {
            localStorage.setItem('dnd_extension_custom_monsters', JSON.stringify(customs));
            saveToBackend();
            
            // Update existing tokens on the map, just like when saving an edited monster
            try {
              const items = await OBR.scene.items.getItems();
              const toUpdate = items.filter(item => {
                if (item.type !== 'IMAGE') return false;
                const metaName = item.metadata?.name;
                if (metaName && metaName === data.name) return true;
                const text = item.text?.plainText || "";
                return text.startsWith(data.name);
              });

              if (toUpdate.length > 0) {
                if (confirm(`Update ${toUpdate.length} existing tokens on the map with these new stats?\n\nChanges:\n${changes.join('\n')}`)) {
                  await OBR.scene.items.updateItems(toUpdate.map(i => i.id), (items) => {
                    for (let item of items) {
                      if (!item.metadata) item.metadata = {};
                      item.metadata.hp = monster.hp;
                      item.metadata.ac = monster.ac;
                      item.metadata.cr = monster.cr;
                      item.metadata.name = monster.name;
                      
                      const hideName = localStorage.getItem('dnd_extension_hide_name') === 'true';
                      const hideHP = localStorage.getItem('dnd_extension_hide_hp') === 'true';
                      const hideAC = localStorage.getItem('dnd_extension_hide_ac') === 'true';
                      const hideCR = localStorage.getItem('dnd_extension_hide_cr') === 'true';

                      let newLabel = "";
                      if (!hideName) newLabel += monster.name;
                      
                      let statsLine = "";
                      const hasHp = !hideHP;
                      const hasAc = !hideAC;
                      const hasCr = !hideCR && monster.cr !== undefined && monster.cr !== "Unknown";
                      
                      if (hasHp) statsLine += `HP: ${monster.hp}`;
                      if (hasHp && hasAc) statsLine += " ";
                      if (hasAc) statsLine += `AC: ${monster.ac}`;
                      if ((hasHp || hasAc) && hasCr) statsLine += " ";
                      if (hasCr) statsLine += `CR: ${monster.cr}`;
                      
                      if (statsLine) {
                        if (newLabel) newLabel += "\n";
                        newLabel += statsLine;
                      }
                      if (!item.text) item.text = { plainText: "" };
                      item.text.plainText = newLabel;
                    }
                  });
                }
              }
            } catch (e) {
              console.error("Failed to sync tokens:", e);
            }
            
            alert(`Stats refreshed for ${data.name}!\n\nChanges:\n${changes.join('\n')}`);
            // Re-render the stats view to show updated data
            const itemIdForRefresh = itemId; // Capture itemId from outer scope
            const updatedData = customs[idx]; // Get the updated monster object
            showStats(updatedData, itemIdForRefresh);
          } else {
            alert("No changes detected—stats are already up to date!\n\nCheck console logs for debugging info.");
          }
        });
      }
    }

    // Share Description Listener
    const shareBtn = document.getElementById('share-description-btn');
    if (shareBtn) {
        shareBtn.addEventListener('click', async () => {
            if (typeof OBR === 'undefined' || !OBR.scene) {
                alert("OBR not ready.");
                return;
            }
            
            shareBtn.disabled = true;
            shareBtn.innerText = "Sharing...";
            
            try {
                // Construct text
                let content = `${data.name}\n`;
                if (isItem) {
                    content += `${data.type || 'Item'} ${data.rarity ? `(${data.rarity})` : ''}\n\n`;
                    content += data.details || descriptionToUse || 'No details.';
                } else {
                    content += `HP: ${data.hp} | AC: ${data.ac} | CR: ${data.cr}\n\n`;
                    content += descriptionToUse || 'No stats.';
                }
                
                // Determine position: Next to item if itemId exists, otherwise center of screen
                let targetX, targetY;
                
                if (itemId) {
                    try {
                        const items = await OBR.scene.items.getItems([itemId]);
                        if (items.length > 0) {
                            const item = items[0];
                            // Place 1 grid unit (approx 150px) to the right of the item
                            // We use a safe default of 150 if grid isn't available, but usually grid dpi is 150
                            const offset = 160; 
                            targetX = item.position.x + offset;
                            targetY = item.position.y;
                        }
                    } catch (err) {
                        console.warn("Could not find item position", err);
                    }
                }

                if (targetX === undefined || targetY === undefined || isNaN(targetX) || isNaN(targetY)) {
                    // Fallback to center of screen
                    try {
                        const pos = await OBR.viewport.getPosition();
                        targetX = pos ? pos.x : 0;
                        targetY = pos ? pos.y : 0;
                    } catch (e) {
                        console.warn("Could not get viewport position", e);
                        targetX = 0;
                        targetY = 0;
                    }
                }
                
                // Create rich text from content (Split by newlines for paragraphs)
                const richText = (content || "Empty Note").split('\n').map(line => ({
                    type: 'paragraph',
                    children: [{ text: line || " " }]
                }));

                // Create text item
                const textItem = buildText()
                    .plainText(content || "Empty Note")
                    .richText(richText)
                    .position({ x: targetX, y: targetY })
                    .fontSize(24)
                    .fillColor('#ffffff')
                    .strokeColor('#000000')
                    .strokeWidth(2)
                    .fontFamily('Roboto')
                    .textAlign('LEFT')
                    .padding(10)
                    .width(400) // Controls wrapping width
                    .layer('TEXT')
                    .build();
                
                console.log("Sharing Note Item:", textItem);
                
                await OBR.scene.items.addItems([textItem]);
                
                shareBtn.innerText = "Shared!";
                setTimeout(() => {
                    shareBtn.disabled = false;
                    shareBtn.innerText = "Share to Map (Note)";
                }, 2000);
                
            } catch (e) {
                console.error("Failed to share note", e);
                shareBtn.innerText = "Error";
                shareBtn.disabled = false;
                
                const errDetail = e.message || (e.error && e.error.message) || JSON.stringify(e);
                alert("Failed to share note: " + errDetail);
            }
        });
    }

    // Add to Scene Listener (for Monsters)
    const addToSceneBtn = document.getElementById('add-to-scene-btn');
    if (addToSceneBtn) {
        addToSceneBtn.addEventListener('click', async () => {
            // Create a modal dialog for preview/edit
            const modalHtml = `
                <div id="place-preview-modal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 999999; color: #fff;">
                    <div style="background: #1a1a1a; padding: 20px; border-radius: 8px; max-width: 500px; width: 90%; max-height: 90vh; overflow-y: auto;">
                        <h3 style="margin-top: 0; color: #4a90d9;">Place ${data.name}</h3>
                        
                        <div style="margin-bottom: 15px;">
                            <label style="display: block; margin-bottom: 5px; font-size: 0.9em;">Name:</label>
                            <input type="text" id="preview-name" value="${data.name}" style="width: 100%; padding: 8px; border: 1px solid #444; border-radius: 4px; background: #2a2a2a; color: white;">
                        </div>
                        
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 15px;">
                            <div>
                                <label style="display: block; margin-bottom: 5px; font-size: 0.9em;">HP:</label>
                                <input type="number" id="preview-hp" value="${data.hp}" style="width: 100%; padding: 8px; border: 1px solid #444; border-radius: 4px; background: #2a2a2a; color: white;">
                            </div>
                            <div>
                                <label style="display: block; margin-bottom: 5px; font-size: 0.9em;">AC:</label>
                                <input type="number" id="preview-ac" value="${data.ac}" style="width: 100%; padding: 8px; border: 1px solid #444; border-radius: 4px; background: #2a2a2a; color: white;">
                            </div>
                        </div>
                        
                        <div style="margin-bottom: 15px;">
                            <label style="display: block; margin-bottom: 5px; font-size: 0.9em;">CR:</label>
                            <input type="text" id="preview-cr" value="${data.cr || ''}" style="width: 100%; padding: 8px; border: 1px solid #444; border-radius: 4px; background: #2a2a2a; color: white;">
                        </div>
                        
                        <div style="margin-bottom: 15px;">
                            <label style="display: block; margin-bottom: 5px; font-size: 0.9em;">Description:</label>
                            <textarea id="preview-description" rows="6" style="width: 100%; padding: 8px; border: 1px solid #444; border-radius: 4px; background: #2a2a2a; color: white; resize: vertical;">${data.description || ''}</textarea>
                        </div>
                        
                        <div style="display: flex; gap: 10px; margin-top: 20px;">
                            <button id="place-cancel-btn" style="flex: 1; padding: 10px; background: #666; color: white; border: none; border-radius: 4px; cursor: pointer;">Cancel</button>
                            <button id="place-confirm-btn" style="flex: 2; padding: 10px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">Place on Map</button>
                        </div>
                    </div>
                </div>
            `;
            
            // Add modal to body
            document.body.insertAdjacentHTML('beforeend', modalHtml);
            
            // Get modal elements
            const modal = document.getElementById('place-preview-modal');
            const cancelBtn = document.getElementById('place-cancel-btn');
            const confirmBtn = document.getElementById('place-confirm-btn');
            const previewName = document.getElementById('preview-name');
            const previewHp = document.getElementById('preview-hp');
            const previewAc = document.getElementById('preview-ac');
            const previewCr = document.getElementById('preview-cr');
            const previewDescription = document.getElementById('preview-description');
            
            // Cancel button handler
            cancelBtn.addEventListener('click', () => {
                modal.remove();
            });
            
            // Confirm button handler
            confirmBtn.addEventListener('click', async () => {
                confirmBtn.disabled = true;
                confirmBtn.innerText = "Placing...";
                
                // Create modified monster data
                const modifiedMonster = {
                    ...data,
                    name: previewName.value,
                    hp: parseInt(previewHp.value) || data.hp,
                    ac: parseInt(previewAc.value) || data.ac,
                    cr: previewCr.value,
                    description: previewDescription.value
                };
                
                try {
                    await addMonsterToScene(modifiedMonster);
                    confirmBtn.innerText = "Placed!";
                    setTimeout(() => {
                        modal.remove();
                        addToSceneBtn.innerText = itemId ? "Add Another to Scene" : "Add to Scene";
                        addToSceneBtn.disabled = false;
                    }, 1000);
                } catch (e) {
                    console.error(e);
                    alert("Error adding to scene: " + e.message);
                    confirmBtn.innerText = "Error";
                    confirmBtn.disabled = false;
                }
            });
            
            // Close modal when clicking outside
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.remove();
                }
            });
        });
    }

    // Add Item to Map Listener
    if (isItem) {
        const addBtn = document.getElementById('add-item-to-map-btn');
        if (addBtn) {
            addBtn.addEventListener('click', async () => {
                if (typeof OBR !== 'undefined' && OBR.player) {
                     addBtn.disabled = true;
                     addBtn.innerText = "Adding...";
                     try {
                        await addItemToScene(data);
                        addBtn.innerText = "Added!";
                        setTimeout(() => {
                            addBtn.disabled = false;
                            addBtn.innerText = "Add to Map";
                        }, 2000);
                     } catch (e) {
                        console.error("Failed to add item", e);
                        addBtn.innerText = "Error";
                        addBtn.disabled = false;
                     }
                } else {
                    alert("OBR not ready or not available.");
                }
            });
        }

        const deleteBtn = document.getElementById('delete-item-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => {
                const choice = confirm(`Choose an option for "${data.name}":\n\n- Click OK to PERMANENTLY DELETE (removes custom entry, restores built-in)\n- Click Cancel to just HIDE from search results`);
                
                if (choice) {
                    // Permanently delete
                    let type;
                    if (isSpell) type = 'spell';
                    else if (isItem) type = 'item';
                    else type = 'monster';
                    
                    deleteItemPermanently(data.name, type);
                    alert(`"${data.name}" has been permanently deleted!`);
                } else {
                    // Just hide
                    deleteItem(data.name);
                    alert(`"${data.name}" has been hidden from search results!`);
                }
                
                // Go back to search
                statsView.style.display = 'none';
                searchView.style.display = 'flex';
                // Refresh search results
                const input = document.getElementById('search-input');
                if (input) renderResults(input.value);
            });
        }
    }

    if (!isSpell && !isItem) {
        const deleteBtn = document.getElementById('delete-item-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => {
                const choice = confirm(`Choose an option for "${data.name}":\n\n- Click OK to PERMANENTLY DELETE (removes custom entry, restores built-in)\n- Click Cancel to just HIDE from search results`);
                
                if (choice) {
                    // Permanently delete
                    deleteItemPermanently(data.name, 'monster');
                    alert(`"${data.name}" has been permanently deleted!`);
                } else {
                    // Just hide
                    deleteItem(data.name);
                    alert(`"${data.name}" has been hidden from search results!`);
                }
                
                // Go back to search
                statsView.style.display = 'none';
                searchView.style.display = 'flex';
                // Refresh search results
                const input = document.getElementById('search-input');
                if (input) renderResults(input.value);
            });
        }
    }

    if (isSpell) {
        const deleteBtn = document.getElementById('delete-item-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => {
                const choice = confirm(`Choose an option for "${data.name}":\n\n- Click OK to PERMANENTLY DELETE (removes custom entry, restores built-in)\n- Click Cancel to just HIDE from search results`);
                
                if (choice) {
                    // Permanently delete
                    deleteItemPermanently(data.name, 'spell');
                    alert(`"${data.name}" has been permanently deleted!`);
                } else {
                    // Just hide
                    deleteItem(data.name);
                    alert(`"${data.name}" has been hidden from search results!`);
                }
                
                // Go back to search
                statsView.style.display = 'none';
                searchView.style.display = 'flex';
                // Refresh search results
                const input = document.getElementById('search-input');
                if (input) renderResults(input.value);
            });
        }

        const castBtn = document.getElementById('cast-spell-btn');
        if (castBtn) {
            castBtn.addEventListener('click', async () => {
                let targetId = itemId;
                if (!targetId && OBR.player) {
                     try {
                         const selection = await OBR.player.getSelection();
                         if (selection && selection.length > 0) {
                             targetId = selection[0];
                         }
                     } catch(e) { console.warn(e); }
                }
                
                if (data.aoe) {
                     let dtype = 'force';
                     const n = data.name.toLowerCase();
                     if (n.includes('fire') || n.includes('burn') || n.includes('flame')) dtype = 'fire';
                     else if (n.includes('cold') || n.includes('ice') || n.includes('frost')) dtype = 'cold';
                     else if (n.includes('lightning') || n.includes('thunder') || n.includes('storm')) dtype = 'lightning';
                     else if (n.includes('acid') || n.includes('poison') || n.includes('venom')) dtype = 'acid';
                     else if (n.includes('necrotic') || n.includes('death') || n.includes('wither')) dtype = 'necrotic';
                     else if (n.includes('radiant') || n.includes('sun') || n.includes('holy')) dtype = 'radiant';
                     else if (n.includes('psychic') || n.includes('mind')) dtype = 'psychic';
                     
                     spawnAoETemplate(targetId, data.aoe, dtype);
                } else {
                     alert("No AoE shape defined for this spell.");
                }
            });
        }
    }

    // Helper: Check if Dice+ is ready
    async function checkDicePlusReady() {
        if (!OBR.broadcast) return false;
        const requestId = crypto.randomUUID();
        return new Promise((resolve) => {
            const unsubscribe = OBR.broadcast.onMessage("dice-plus/isReady", (event) => {
                const data = event.data;
                if ('ready' in data && data.requestId === requestId) {
                    unsubscribe();
                    resolve(true);
                }
            });
            OBR.broadcast.sendMessage("dice-plus/isReady", {
                requestId,
                timestamp: Date.now()
            }, { destination: 'ALL' });
            setTimeout(() => {
                unsubscribe();
                resolve(false);
            }, 1000);
        });
    }

    // Helper: Roll with Dice+
    async function rollWithDicePlus(diceNotation, label) {
        const MY_EXTENSION_ID = "com.dnd-extension";
        const rollId = `roll_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const playerId = await OBR.player.getId();
        const playerName = await OBR.player.getName();
        
        return new Promise((resolve, reject) => {
            let unsubscribeResult = null;
            let unsubscribeError = null;
            
            const cleanup = () => {
                if (unsubscribeResult) unsubscribeResult();
                if (unsubscribeError) unsubscribeError();
            };
            
            unsubscribeResult = OBR.broadcast.onMessage(`${MY_EXTENSION_ID}/roll-result`, (event) => {
                const result = event.data;
                if (result.rollId === rollId) {
                    cleanup();
                    resolve(result);
                }
            });
            
            unsubscribeError = OBR.broadcast.onMessage(`${MY_EXTENSION_ID}/roll-error`, (event) => {
                const error = event.data;
                if (error.rollId === rollId) {
                    cleanup();
                    reject(error);
                }
            });
            
            OBR.broadcast.sendMessage("dice-plus/roll-request", {
                rollId,
                playerId,
                playerName,
                rollTarget: 'everyone',
                diceNotation: diceNotation + (label ? ` # ${label}` : ''),
                showResults: true,
                timestamp: Date.now(),
                source: MY_EXTENSION_ID
            }, { destination: 'ALL' });
            
            // Add a timeout for the roll (5 seconds)
            setTimeout(() => {
                cleanup();
                reject({ error: 'TIMEOUT' });
            }, 5000);
        });
    }

    // Helper: Check if JustDices is ready
    async function checkJustDicesReady() {
        if (!OBR.broadcast) return false;
        return true; // Assume it's there if we get a response, use timeout
    }

    // Helper: Roll with JustDices
    async function rollWithJustDices(expression, label) {
        const callId = `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        return new Promise((resolve, reject) => {
            const unsubscribe = OBR.broadcast.onMessage("justdices.api.response", (evt) => {
                const res = evt.data;
                if (res.callId !== callId) return;
                unsubscribe();
                if (res.ok) {
                    resolve(res);
                } else {
                    reject(res);
                }
            });
            OBR.broadcast.sendMessage("justdices.api.request", {
                callId,
                expression: `/r ${expression}${label ? ` ${label}` : ''}`,
                showInLogs: true
            }, { destination: 'ALL' });
            setTimeout(() => {
                unsubscribe();
                reject({ error: 'API_TIMEOUT' });
            }, 3000);
        });
    }

    // Track if a roll is in progress
    let rollInProgress = false;
    
    // Roll Handler Logic (Defined here to close over currentActions)
    const handleRoll = async (e) => {
        if (rollInProgress) {
            console.warn('Roll already in progress, skipping...');
            return;
        }
        rollInProgress = true;
        try {
        // Find closest button (in case of icon clicks)
        const btn = e.target.closest('.roll-btn');
        if (!btn) return;

        const index = parseInt(btn.getAttribute('data-index'), 10);
        const type = btn.getAttribute('data-type');
        
        // For abilities/saves, we don't need index or actions array
        if (type === 'ability' || type === 'save-check') {
             const name = btn.getAttribute('data-name');
             const mod = parseInt(btn.getAttribute('data-mod'), 10);
             const diceNotation = `1d20${mod >= 0 ? '+' : ''}${mod}`;
             const label = `${name} ${type === 'ability' ? 'Check' : 'Save'}`;
             
             // Try Dice+ first
             let result = null;
             try {
                 const dicePlusReady = await checkDicePlusReady();
                 if (dicePlusReady) {
                     result = await rollWithDicePlus(diceNotation, label);
                 }
             } catch (err) {
                 console.warn("Dice+ roll failed, trying JustDices...", err);
                 try {
                     result = await rollWithJustDices(diceNotation, label);
                 } catch (err2) {
                     console.warn("JustDices roll failed, using local roll...", err2);
                 }
             }
             
             let resultText = '';
             if (result) {
                 if (result.result && result.result.totalValue) {
                     resultText = `${label}: ${result.result.rollSummary}`;
                 } else if (result.data && result.data.total !== undefined) {
                     resultText = `${label}: ${result.expressionOut} = ${result.data.total}`;
                 }
             }
             
             if (!resultText) {
                 const roll = Math.floor(Math.random() * 20) + 1;
                 const total = roll + mod;
                 const crit = roll === 20 ? ' (NAT 20!)' : (roll === 1 ? ' (NAT 1!)' : '');
                 resultText = `${name} ${type === 'ability' ? 'Check' : 'Save'}: ${roll} ${mod >= 0 ? '+' : ''}${mod} = ${total}${crit}`;
             }
             
             // Broadcast
             try {
                if (OBR.notification && OBR.player) {
                    const pname = await OBR.player.getName();
                    const msg = `${pname} rolled: ${resultText}`;
                    await OBR.notification.show(msg);
                    if (OBR.broadcast) OBR.broadcast.sendMessage(CHANNEL_ID, msg);
                } else {
                    alert(resultText);
                }
             } catch (e) { alert(resultText); }
             return; 
        }

        let action;
        if (index === -1) {
            action = quickCastAction;
        } else {
            action = currentActions[index];
        }
        if (!action) return;

        let resultText = '';
        
        if (type === 'attack') {
            const diceNotation = `1d20+${action.toHit}`;
            const label = `${action.name} Attack`;
            let result = null;
            try {
                const dicePlusReady = await checkDicePlusReady();
                if (dicePlusReady) {
                    result = await rollWithDicePlus(diceNotation, label);
                }
            } catch (err) {
                console.warn("Dice+ roll failed, trying JustDices...", err);
                try {
                    result = await rollWithJustDices(diceNotation, label);
                } catch (err2) {
                    console.warn("JustDices roll failed, using local roll...", err2);
                }
            }
            
            if (result) {
                if (result.result && result.result.totalValue) {
                    resultText = `${label}: ${result.result.rollSummary}`;
                } else if (result.data && result.data.total !== undefined) {
                    resultText = `${label}: ${result.expressionOut} = ${result.data.total}`;
                }
            }
            
            if (!resultText) {
                const roll = Math.floor(Math.random() * 20) + 1;
                const rollTotal = roll + action.toHit;
                const crit = roll === 20 ? ' (CRIT!)' : (roll === 1 ? ' (FAIL!)' : '');
                resultText = `${action.name} Attack: ${roll} + ${action.toHit} = ${rollTotal}${crit}`;
            }
        } else if (type === 'damage') {
            const damageIndex = parseInt(btn.getAttribute('data-damage-index'), 10);
            const damageInfo = action.damages[damageIndex];
            
            if (itemId) {
                const dmgType = damageInfo ? damageInfo.type : 'force';
                triggerDamageEffect(itemId, dmgType);
            }

            if (damageInfo) {
                const label = `${action.name} ${damageInfo.type} Damage`;
                let result = null;
                try {
                    const dicePlusReady = await checkDicePlusReady();
                    if (dicePlusReady) {
                        result = await rollWithDicePlus(damageInfo.dice, label);
                    }
                } catch (err) {
                    console.warn("Dice+ roll failed, trying JustDices...", err);
                    try {
                        result = await rollWithJustDices(damageInfo.dice, label);
                    } catch (err2) {
                        console.warn("JustDices roll failed, using local roll...", err2);
                    }
                }
                
                if (result) {
                    if (result.result && result.result.totalValue) {
                        resultText = `${label}: ${result.result.rollSummary}`;
                    } else if (result.data && result.data.total !== undefined) {
                        resultText = `${label}: ${result.expressionOut} = ${result.data.total}`;
                    }
                }
                
                if (!resultText) {
                    const localResult = rollDice(damageInfo.dice);
                    if (localResult) {
                        resultText = `${action.name} Damage: ${localResult.total} (${localResult.formula}) ${damageInfo.type}`;
                    } else {
                        resultText = `Error rolling ${damageInfo.dice}`;
                    }
                }
            } else {
                 resultText = "Error: Damage info not found";
            }
        } else if (type === 'spell') {
            const spellIndex = parseInt(btn.getAttribute('data-spell-index'), 10);
            const spell = action.spells[spellIndex];
            
            if (spell) {
                if (spell.dice) {
                    const label = `${spell.name}`;
                    let result = null;
                    try {
                        const dicePlusReady = await checkDicePlusReady();
                        if (dicePlusReady) {
                            result = await rollWithDicePlus(spell.dice, label);
                        }
                    } catch (err) {
                        console.warn("Dice+ roll failed, trying JustDices...", err);
                        try {
                            result = await rollWithJustDices(spell.dice, label);
                        } catch (err2) {
                            console.warn("JustDices roll failed, using local roll...", err2);
                        }
                    }
                    
                    if (result) {
                        if (result.result && result.result.totalValue) {
                            resultText = `${action.name} Casts ${spell.name}: ${result.result.rollSummary}`;
                        } else if (result.data && result.data.total !== undefined) {
                            resultText = `${action.name} Casts ${spell.name}: ${result.expressionOut} = ${result.data.total}`;
                        }
                    }
                    
                    if (!resultText) {
                        const localResult = rollDice(spell.dice);
                        if (localResult) {
                            resultText = `${action.name} Casts ${spell.name}: ${localResult.total} (${localResult.formula})`;
                        } else {
                            resultText = `Error rolling ${spell.dice}`;
                        }
                    }
                } else {
                    resultText = `Casts ${spell.name} (${spell.label || 'Spell'})`;
                }
            } else {
                 resultText = "Error: Spell info not found";
            }
        } else if (type === 'spell-aoe') {
            const spellIndex = parseInt(btn.getAttribute('data-spell-index'), 10);
            const spell = action.spells[spellIndex];
            
            if (spell && spell.aoe) {
                 let dmgType = 'force';
                 const n = spell.name.toLowerCase();
                 // Simple keyword matching for effect color
                 if (n.includes('fire') || n.includes('burn')) dmgType = 'fire';
                 else if (n.includes('cold') || n.includes('ice')) dmgType = 'cold';
                 else if (n.includes('lightning') || n.includes('thunder')) dmgType = 'lightning';
                 else if (n.includes('acid') || n.includes('poison')) dmgType = 'acid';
                 else if (n.includes('necrotic') || n.includes('death')) dmgType = 'necrotic';
                 else if (n.includes('radiant') || n.includes('sun')) dmgType = 'radiant';
                 else if (n.includes('psychic')) dmgType = 'psychic';
                 
                 spawnAoETemplate(itemId, spell.aoe, dmgType);
                 resultText = `Placed ${spell.aoe.size}ft ${spell.aoe.type} template for ${spell.name}.`;
            } else {
                 resultText = "Error: AoE data missing.";
            }
        } else if (type === 'save') {
            resultText = `Requests DC ${action.save.dc} ${action.save.stat} Save against ${action.name}`;
            if (itemId && action.damages && action.damages.length > 0) {
                const dmgType = action.damages[0].type || 'force';
                triggerDamageEffect(itemId, dmgType);
            }
        } else if (type === 'aoe-template') {
            if (action.aoe) {
                const dmgType = (action.damages && action.damages.length > 0) ? action.damages[0].type : 'force';
                spawnAoETemplate(itemId, action.aoe, dmgType);
                resultText = `Placed ${action.aoe.size}ft ${action.aoe.type} template.`;
            } else {
                resultText = "Error: AoE data missing.";
            }
        }
        
        // Broadcast
        try {
            if (OBR.notification && OBR.player) {
                const name = await OBR.player.getName();
                const msg = resultText.startsWith('Requests') ? `${name} ${resultText}` : `${name} rolled: ${resultText}`;
                await OBR.notification.show(msg);
                if (OBR.broadcast) OBR.broadcast.sendMessage(CHANNEL_ID, msg);
            } else {
                alert(resultText);
            }
        } catch (e) { alert(resultText); }
        } finally {
            rollInProgress = false;
        }
    };

    // Attach Listeners Helper
    const attachActionListeners = () => {
        const rollBtns = statsContent.querySelectorAll('.roll-btn');
        rollBtns.forEach(btn => {
             // Cleanest way is to remove listener first if possible, but here we are re-rendering DOM nodes mostly.
             // For static nodes (like abilities), we might be adding multiple listeners if we re-run this.
             // But we only call attachActionListeners when we renderActionsUI, which replaces the #actions-wrapper.
             // We need to be careful about the Ability/Save buttons which are static in statsContent.
             // We will scope the listener attachment to #actions-wrapper for dynamic ones.
        });
        
        // Actually, easiest is to just attach to document with delegation, but keeping it simple:
        // We will remove all listeners by cloning nodes? No.
        // We'll just attach to the new nodes in actions-wrapper.
        
        const actionBtns = document.getElementById('actions-wrapper').querySelectorAll('.roll-btn');
        actionBtns.forEach(btn => btn.addEventListener('click', handleRoll));
        
        // For static buttons (Abilities/Saves), they are created once in showStats.
        // We should attach to them once.
        // Since showStats is called once per open, this is fine.
        const staticBtns = statsContent.querySelectorAll('.roll-btn:not(#actions-wrapper .roll-btn)');
        staticBtns.forEach(btn => btn.addEventListener('click', handleRoll));
    };

    const renderActionsUI = () => {
        const wrapper = document.getElementById('actions-wrapper');
        const groupedActions = { traits: [], actions: [], reactions: [], legendary: [] };
        currentActions.forEach((action, index) => {
            const actionWithIndex = { ...action, index };
            if (groupedActions[action.section]) groupedActions[action.section].push(actionWithIndex);
            else groupedActions.actions.push(actionWithIndex);
        });
        
        wrapper.innerHTML = `
            <div style="margin-top: 10px; border-top: 1px solid #ccc; padding-top: 10px;">
                ${groupedActions.traits.length > 0 ? `<h3 style="margin-bottom: 5px; border-bottom: 1px solid #eee;">Traits</h3>${groupedActions.traits.map(a => renderCard(a, a.index)).join('')}` : ''}
                ${groupedActions.actions.length > 0 ? `<h3 style="margin-top: 15px; margin-bottom: 5px; border-bottom: 1px solid #eee;">Actions</h3>${groupedActions.actions.map(a => renderCard(a, a.index)).join('')}` : ''}
                ${groupedActions.reactions.length > 0 ? `<h3 style="margin-top: 15px; margin-bottom: 5px; border-bottom: 1px solid #eee;">Reactions</h3>${groupedActions.reactions.map(a => renderCard(a, a.index)).join('')}` : ''}
                ${groupedActions.legendary.length > 0 ? `<h3 style="margin-top: 15px; margin-bottom: 5px; border-bottom: 1px solid #eee;">Legendary Actions</h3>${groupedActions.legendary.map(a => renderCard(a, a.index)).join('')}` : ''}
            </div>
        `;
        
        // Only attach to the new buttons we just created
        const actionBtns = wrapper.querySelectorAll('.roll-btn');
        actionBtns.forEach(btn => btn.addEventListener('click', handleRoll));
    };

    // Initial Render
    renderActionsUI();
    
    // Attach to static buttons (Abilities/Saves)
    const staticBtns = statsContent.querySelectorAll('.roll-btn:not(#actions-wrapper .roll-btn)');
    staticBtns.forEach(btn => btn.addEventListener('click', handleRoll));

    // Manual Spell Search Logic
    const msInput = document.getElementById('manual-spell-input');
    const msResults = document.getElementById('manual-spell-results');
    
    msInput.addEventListener('input', (e) => {
        const val = e.target.value.toLowerCase().trim();
        if (val.length < 2) {
            msResults.style.display = 'none';
            return;
        }
        
        const customSpells = getCustomSpells();
        const customNames = customSpells.map(s => s.name);
        const builtInNames = Object.keys(SPELL_DATA);
        // Combine and dedup (custom overrides built-in)
        const allNames = [...new Set([...customNames, ...builtInNames])];
        
        const matches = allNames.filter(k => k.toLowerCase().includes(val)).slice(0, 20); // Limit results
        if (matches.length === 0) {
             msResults.style.display = 'none';
             return;
        }
        
        msResults.innerHTML = matches.map(k => {
            let sData = customSpells.find(s => s.name === k);
            if (!sData) sData = SPELL_DATA[k];
            const lvl = (sData && sData.level !== undefined) ? sData.level : 0;
            return `
            <div class="ms-item" data-key="${k}" style="padding: 5px; cursor: pointer; border-bottom: 1px solid #eee;">
                <strong>${k}</strong> <span style="font-size: 0.8em; color: #666;">${lvl > 0 ? 'Lvl '+lvl : 'Cantrip'}</span>
            </div>
            `;
        }).join('');
        msResults.style.display = 'block';
        
        msResults.querySelectorAll('.ms-item').forEach(item => {
            item.addEventListener('click', () => {
                const key = item.dataset.key;
                
                let data = customSpells.find(s => s.name === key);
                if (!data) data = SPELL_DATA[key];
                
                const baseLevel = (data && data.level !== undefined) ? data.level : 0;
                
                const createQuickAction = (castLevel) => {
                     const displayName = key.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                     const levelDiff = Math.max(0, castLevel - baseLevel);
                     
                     const scaledDamages = [];
                     if (data.damage) {
                         const match = data.damage.match(/(\d+)d(\d+)/);
                         if (match) {
                             const count = parseInt(match[1], 10) + levelDiff;
                             const sides = match[2];
                             // Replace only the dice part in the original string to keep modifiers
                             const newDice = data.damage.replace(match[0], `${count}d${sides}`);
                             scaledDamages.push({ dice: newDice, type: data.type });
                         } else {
                             scaledDamages.push({ dice: data.damage, type: data.type });
                         }
                     }
                     if (data.secondary) {
                          scaledDamages.push({ dice: data.secondary.damage, type: data.secondary.type });
                     }

                     return {
                        name: `${displayName} (Lvl ${castLevel})`,
                        originalText: `Quick Cast at Level ${castLevel}.`,
                        section: 'actions',
                        isTrait: false,
                        toHit: (data.attack && globalToHit) ? parseInt(globalToHit, 10) : undefined,
                        save: (data.save && globalSaveDC) ? { dc: parseInt(globalSaveDC, 10), stat: data.save } : undefined,
                        damages: scaledDamages,
                        spells: [],
                        aoe: data.aoe
                     };
                };

                // Initial set
                let currentLevel = Math.max(1, baseLevel); 
                quickCastAction = createQuickAction(currentLevel);
                
                const renderQuickCast = () => {
                    const container = document.getElementById('quick-cast-container');
                    
                    let levelSelectHtml = '';
                    if (baseLevel > 0) {
                        let options = '';
                        for (let i = baseLevel; i <= 9; i++) {
                            options += `<option value="${i}" ${i === currentLevel ? 'selected' : ''}>Level ${i}</option>`;
                        }
                        levelSelectHtml = `
                            <div style="margin-bottom: 5px; display: flex; align-items: center; gap: 5px; font-size: 0.9em;">
                                <span>Cast at:</span>
                                <select id="qc-level-select" style="padding: 2px;">
                                    ${options}
                                </select>
                            </div>
                        `;
                    }

                    container.innerHTML = `
                        <div style="background: #fff; color: black; padding: 5px; border: 1px solid #3f51b5; border-radius: 4px;">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                                ${levelSelectHtml || '<div></div>'}
                                <button id="qc-close-btn" style="background: none; border: none; font-weight: bold; color: #999; cursor: pointer;">✕</button>
                            </div>
                            ${renderCard(quickCastAction, -1)}
                        </div>
                    `;
                    
                    const closeBtn = document.getElementById('qc-close-btn');
                    closeBtn.addEventListener('click', () => {
                        quickCastAction = null;
                        container.innerHTML = '';
                    });
                    
                    const lvlSelect = document.getElementById('qc-level-select');
                    if (lvlSelect) {
                        lvlSelect.addEventListener('change', (e) => {
                            currentLevel = parseInt(e.target.value, 10);
                            quickCastAction = createQuickAction(currentLevel);
                            renderQuickCast();
                        });
                    }
                    
                    const rollBtns = container.querySelectorAll('.roll-btn');
                    rollBtns.forEach(btn => btn.addEventListener('click', handleRoll));
                };

                renderQuickCast();
                
                msInput.value = '';
                msResults.style.display = 'none';
            });
        });
    });
    
    // Hide results on click outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#manual-spell-input') && !e.target.closest('#manual-spell-results')) {
            msResults.style.display = 'none';
        }
    });



    if (itemId) {
        const btn = document.getElementById('update-stats-btn');
        const hpInput = document.getElementById('hp-input');
        const acInput = document.getElementById('ac-input');
        const adjustAmountInput = document.getElementById('stat-adjust-amount');
        
        const hpPlusBtn = document.getElementById('hp-plus-btn');
        const hpMinusBtn = document.getElementById('hp-minus-btn');
        const acPlusBtn = document.getElementById('ac-plus-btn');
        const acMinusBtn = document.getElementById('ac-minus-btn');
        
        const hpResetBtn = document.getElementById('hp-reset-btn');
        const acResetBtn = document.getElementById('ac-reset-btn');

        const updateTokenStats = async (newHp, newAc) => {
            try {
                await OBR.scene.items.updateItems([itemId], (items) => {
                    for (let item of items) {
                        item.metadata.hp = newHp;
                        item.metadata.ac = newAc;
                        
                        // Respect hide settings
                        const hideName = localStorage.getItem('dnd_extension_hide_name') === 'true';
                        const hideHP = localStorage.getItem('dnd_extension_hide_hp') === 'true';
                        const hideAC = localStorage.getItem('dnd_extension_hide_ac') === 'true';
                        const hideCR = localStorage.getItem('dnd_extension_hide_cr') === 'true';
                        const cr = item.metadata.cr;

                        // Try to get name from metadata, fallback to label only if it doesn't look like stats
                        let name = item.metadata.name;
                        if (!name && item.text && item.text.plainText) {
                            const firstLine = item.text.plainText.split('\n')[0];
                            if (!firstLine.startsWith('HP:') && !firstLine.startsWith('AC:')) {
                                name = firstLine;
                            }
                        }
                        if (!name) name = "Unknown";
                        
                        let newLabel = "";
                        if (!hideName) newLabel += name;
                        
                        let statsLine = "";
                        if (!hideHP) statsLine += `HP: ${newHp}`;
                        if (!hideHP && !hideAC) statsLine += " ";
                        if (!hideAC) statsLine += `AC: ${newAc}`;
                        if ((!hideHP || !hideAC) && !hideCR && cr !== undefined) statsLine += " ";
                        if (!hideCR && cr !== undefined) statsLine += `CR: ${cr}`;
                        
                        if (statsLine) {
                            if (newLabel) newLabel += "\n";
                            newLabel += statsLine;
                        }
                        item.text.plainText = newLabel;
                    }
                });

                // Sync to Library (Permanent Change)
                const updatedMonster = { 
                    ...data, 
                    hp: newHp, 
                    ac: newAc,
                    source: data.source || "Custom" 
                };
                
                saveCustomMonster(updatedMonster);

                if (btn) {
                    const originalText = btn.innerText;
                    btn.innerText = "Saved!";
                    setTimeout(() => btn.innerText = originalText, 1000);
                }
            } catch (err) {
                console.error("Failed to update token stats:", err);
            }
        };

        const handleStatAdjustment = async (type, delta) => {
            const amount = parseInt(adjustAmountInput.value, 10) || 1;
            const input = type === 'hp' ? hpInput : acInput;
            const newValue = parseInt(input.value, 10) + (delta * amount);
            input.value = newValue;
            
            // Trigger update immediately
            await updateTokenStats(parseInt(hpInput.value, 10), parseInt(acInput.value, 10));
        };

        if (hpPlusBtn) hpPlusBtn.addEventListener('click', () => handleStatAdjustment('hp', 1));
        if (hpMinusBtn) hpMinusBtn.addEventListener('click', () => handleStatAdjustment('hp', -1));
        if (acPlusBtn) acPlusBtn.addEventListener('click', () => handleStatAdjustment('ac', 1));
        if (acMinusBtn) acMinusBtn.addEventListener('click', () => handleStatAdjustment('ac', -1));

        if (hpResetBtn) {
            hpResetBtn.addEventListener('click', async () => {
                try {
                    const items = await OBR.scene.items.getItems([itemId]);
                    if (items.length > 0) {
                        const currentItem = items[0];
                        const monsterName = currentItem.metadata.name;
                        const original = monsters.find(m => m.name === monsterName) || 
                                         getCustomMonsters().find(m => m.name === monsterName);
                        if (original) {
                            const defaultHp = parseStat(original.hp);
                            hpInput.value = defaultHp;
                            await updateTokenStats(defaultHp, parseInt(acInput.value, 10));
                        }
                    }
                } catch (e) {
                    console.error("Failed to reset HP", e);
                }
            });
        }

        if (acResetBtn) {
            acResetBtn.addEventListener('click', async () => {
                try {
                    const items = await OBR.scene.items.getItems([itemId]);
                    if (items.length > 0) {
                        const currentItem = items[0];
                        const monsterName = currentItem.metadata.name;
                        const original = monsters.find(m => m.name === monsterName) || 
                                         getCustomMonsters().find(m => m.name === monsterName);
                        if (original) {
                            const defaultAc = parseStat(original.ac);
                            acInput.value = defaultAc;
                            await updateTokenStats(parseInt(hpInput.value, 10), defaultAc);
                        }
                    }
                } catch (e) {
                    console.error("Failed to reset AC", e);
                }
            });
        }

        if (btn && hpInput && acInput) {
            btn.addEventListener('click', async () => {
                const newHp = parseInt(hpInput.value, 10);
                const newAc = parseInt(acInput.value, 10);
                await updateTokenStats(newHp, newAc);
            });
        }
    }

    const editBtn = document.getElementById('edit-btn');
    if (editBtn) {
        editBtn.addEventListener('click', () => {
             if (isSpell) {
                 openEditor('spell', { ...data, description: descriptionToUse });
             } else {
                 openEditor(isItem ? 'item' : 'monster', { ...data, description: descriptionToUse });
             }
        });
    }

    const castSpellBtn = document.getElementById('cast-spell-btn');
    if (castSpellBtn) {
        castSpellBtn.addEventListener('click', async () => {
             const selection = await OBR.player.getSelection();
             if (selection && selection.length > 0) {
                 if (data.aoe) {
                     spawnAoETemplate(selection[0], data.aoe, data.type || 'force');
                 } else {
                     alert("This spell has no AoE shape defined.");
                 }
             } else {
                 alert("Please select a token to cast this spell from.");
             }
        });
    }
  };

  const renderResults = (query) => {
    let html = '';
    
    if (activeTab === 'monsters' && isGM) {
        const searchNameOnly = searchNameOnlyCheckbox ? searchNameOnlyCheckbox.checked : false;
        const minCr = minCrInput ? minCrInput.value.trim() : '';
        const maxCr = maxCrInput ? maxCrInput.value.trim() : '';
        const results = searchMonsters(query, searchNameOnly, minCr, maxCr);
        
        html = results.map((m, index) => `
          <div class="result-card monster-card" data-index="${index}" style="border: 1px solid #ccc; padding: 12px; margin-bottom: 5px; cursor: pointer; border-radius: 4px;">
            <strong>${m.name}</strong> (CR: ${m.cr || '?'})<br>
            <small>HP: ${m.hp}, AC: ${m.ac} | ${m.source}</small>
          </div>
        `).join('');
    } else if (activeTab === 'items') {
        const results = searchItems(query);
        html = results.map((item, index) => `
          <div class="result-card item-card" data-index="${index}" style="border: 1px solid #ccc; padding: 12px; margin-bottom: 5px; cursor: pointer; background: #fff; color: #000; border-radius: 4px;">
            <strong>${item.name}</strong><br>
            <small>${item.type} | ${item.source}</small>
          </div>
        `).join('');
    } else if (activeTab === 'spells') {
        const results = searchSpells(query);
        html = results.map((spell, index) => `
          <div class="result-card spell-card" data-index="${index}" style="border: 1px solid #ccc; padding: 12px; margin-bottom: 5px; cursor: pointer; background: #fff; color: #000; border-radius: 4px;">
            <strong>${spell.name}</strong><br>
            <small>Lvl ${spell.level !== undefined ? spell.level : '?'} ${spell.school || ''} | ${spell.source || 'SRD'}</small>
          </div>
        `).join('');
    } else if (activeTab === 'custom' && isGM) {
        const customMonsters = getCustomMonsters();
        const customItems = getCustomItems();
        const customSpells = getCustomSpells();
        const allCustom = [...customMonsters.map(m => ({...m, type: 'Monster'})), ...customItems.map(i => ({...i, type: 'Item'})), ...customSpells.map(s => ({...s, type: 'Spell'}))];
        
        let results = allCustom;
        if (query) {
            const lowerQuery = query.toLowerCase();
            results = allCustom.filter(item => 
                item.name.toLowerCase().includes(lowerQuery) || 
                (item.description && item.description.toLowerCase().includes(lowerQuery))
            );
        }
        
        html = results.map((item, index) => `
          <div class="result-card custom-card" data-index="${index}" style="border: 1px solid #ccc; padding: 12px; margin-bottom: 5px; cursor: pointer; background: #f0f8ff; color: #000; border-radius: 4px;">
            <strong>${item.name}</strong> [${item.type}]<br>
            <small>${item.type === 'Monster' ? `HP: ${item.hp || '?'}, AC: ${item.ac || '?'}, CR: ${item.cr || '?'}` : item.type === 'Spell' ? `Lvl ${item.level !== undefined ? item.level : '?'} ${item.school || ''}` : item.type || ''}</small>
          </div>
        `).join('');
    } else if (activeTab === 'custom' && !isGM) {
        const customItems = getCustomItems();
        const customSpells = getCustomSpells();
        const allCustom = [...customItems.map(i => ({...i, type: 'Item'})), ...customSpells.map(s => ({...s, type: 'Spell'}))];
        
        let results = allCustom;
        if (query) {
            const lowerQuery = query.toLowerCase();
            results = allCustom.filter(item => 
                item.name.toLowerCase().includes(lowerQuery) || 
                (item.description && item.description.toLowerCase().includes(lowerQuery))
            );
        }
        
        html = results.map((item, index) => `
          <div class="result-card custom-card" data-index="${index}" style="border: 1px solid #ccc; padding: 12px; margin-bottom: 5px; cursor: pointer; background: #f0f8ff; color: #000; border-radius: 4px;">
            <strong>${item.name}</strong> [${item.type}]<br>
            <small>${item.type === 'Spell' ? `Lvl ${item.level !== undefined ? item.level : '?'} ${item.school || ''}` : item.type || ''}</small>
          </div>
        `).join('');
    }

    resultsDiv.innerHTML = html;

  // Helper: Parse stat to integer safely
  const parseStat = (val) => {
      if (typeof val === 'number') return val;
      if (typeof val === 'string') {
          const match = val.match(/^(\d+)/);
          return match ? parseInt(match[1]) : 10;
      }
      return 10;
  };

  const handleMonsterClick = async (monster) => {
      // Reuse existing monster click logic
      try {
            let selection = await OBR.player.getSelection();
            
            // If no manual selection, check if we were opened via context menu for a specific item
            if ((!selection || selection.length === 0)) {
                const searchParams = new URLSearchParams(window.location.search);
                const ctxItemId = searchParams.get('itemId');
                if (ctxItemId) {
                    selection = [ctxItemId];
                }
            }

            // Check if user has selected exactly one item that is an IMAGE
            if (selection && selection.length === 1) {
                const items = await OBR.scene.items.getItems(selection);
                const selectedItem = items[0];

                if (selectedItem && selectedItem.type === 'IMAGE') {
                    // Ask user if they want to assign this monster to the selected image
                    if (confirm(`Assign stats for "${monster.name}" to the selected image?`)) {
                        
                        // 1. Determine size in squares
                        let squares = 1;
                        if (monster.type) {
                            const lowerType = monster.type.toLowerCase();
                            if (lowerType.includes('gargantuan')) squares = 4;
                            else if (lowerType.includes('huge')) squares = 3;
                            else if (lowerType.includes('large')) squares = 2;
                        }

                        // 2. Calculate DPI based on ACTUAL image dimensions (to prevent artifacts/disappearing)
                        let imgDpi = 150; // Default fallback
                        let imgWidth = selectedItem.image.width;
                        let imgHeight = selectedItem.image.height;

                        // Try to get natural dimensions if possible
                        const dims = await getImageDimensions(selectedItem.image.url);
                        if (dims && dims.width && dims.height) {
                            imgWidth = dims.width;
                            imgHeight = dims.height;
                            const maxDim = Math.max(imgWidth, imgHeight);
                            imgDpi = maxDim / squares;
                        } else {
                             imgDpi = 150;
                        }

                        // 3. Save this image association for future adds of this monster
                        const safeUrl = await ensureShortImageUrl(selectedItem.image.url);
                        localStorage.setItem(`monster_image_${monster.name}`, safeUrl);
                        addUsedImageForEntry(monster.name, safeUrl);
                        saveToBackend(); // Sync to backend immediately

                        // 4. Update the item
                        await OBR.scene.items.updateItems([selectedItem.id], (items) => {
                            for (let item of items) {
                                // Update metadata
                                const hpVal = parseStat(monster.hp);
                                const acVal = parseStat(monster.ac);
                                item.metadata = { 
                                    ...item.metadata, 
                                    ...monster, 
                                    hp: hpVal,
                                    ac: acVal,
                                    maxHp: hpVal,
                                    created_by: 'dnd_extension' 
                                };
                                
                                // Update image URL if we optimized it
                                if (safeUrl !== selectedItem.image.url) {
                                    item.image.url = safeUrl;
                                }
                                
                                // Update text label safely
                                if (!item.text) {
                                    item.text = {
                                        richText: [], 
                                        style: {}
                                    };
                                }
                                
                                // Respect hide settings
                                const hideName = localStorage.getItem('dnd_extension_hide_name') === 'true';
                                const hideHP = localStorage.getItem('dnd_extension_hide_hp') === 'true';
                                const hideAC = localStorage.getItem('dnd_extension_hide_ac') === 'true';

                                let newLabel = "";
                                if (!hideName) newLabel += monster.name;
                                
                                let statsLine = "";
                                if (!hideHP) statsLine += `HP: ${hpVal}`;
                                if (!hideHP && !hideAC) statsLine += " ";
                                if (!hideAC) statsLine += `AC: ${acVal}`;
                                
                                if (statsLine) {
                                    if (newLabel) newLabel += "\n";
                                    newLabel += statsLine;
                                }
                                item.text.plainText = newLabel;
                                // Note: item.text.visible is not a valid property on IMAGE items
                                
                                if (!item.text.style) item.text.style = {};
                                item.text.style.fillColor = "#ffffff";
                                item.text.style.strokeColor = "#000000";
                                item.text.style.strokeWidth = 2;
                                item.text.style.fontSize = 24;
                                item.text.style.fontFamily = "Roboto";
                                item.text.style.textAlign = "CENTER";
                                item.text.style.textAlignVertical = "BOTTOM";

                                // Apply resizing (DPI adjustment)
                                if (!item.grid) item.grid = { dpi: 150, offset: { x: 0, y: 0 } };
                                
                                if (dims) {
                                    item.image.width = imgWidth;
                                    item.image.height = imgHeight;
                                    item.grid.dpi = imgDpi;
                                } else {
                                    // Fallback resize logic if we couldn't get true dims
                                    item.image.width = squares * 150;
                                    item.image.height = squares * 150;
                                    item.grid.dpi = 150;
                                }
                                
                                // Reset scale to avoid distortion from previous manual resizing
                                item.scale = { x: 1, y: 1 };
                            }
                        });

                        alert(`Assigned "${monster.name}" to selected image and resized to ${squares}x${squares} squares.`);
                        return; // Done
                    }
                }
            }

            // Default behavior: Add new token
            await addMonsterToScene(monster);
        } catch (e) {
            console.error("Failed to add/assign monster:", e);
            alert(`Error: ${e.message || JSON.stringify(e)}`);
        }
  };

    // Add click listeners
    const cards = resultsDiv.querySelectorAll('.result-card');
    cards.forEach((card) => {
      card.addEventListener('click', async () => {
        const index = parseInt(card.dataset.index, 10);
        
        if (activeTab === 'monsters' && isGM) {
            const searchNameOnly = searchNameOnlyCheckbox ? searchNameOnlyCheckbox.checked : false;
            const minCr = minCrInput ? minCrInput.value.trim() : '';
            const maxCr = maxCrInput ? maxCrInput.value.trim() : '';
            const results = searchMonsters(query, searchNameOnly, minCr, maxCr);
            const monster = results[index];
            await handleMonsterClick(monster);
        } else if (activeTab === 'items') {
            const results = searchItems(query);
            const item = results[index];
            showStats(item);
        } else if (activeTab === 'spells') {
            const results = searchSpells(query);
            const spell = results[index];
            showStats(spell);
        } else if (activeTab === 'custom') {
            if (isGM) {
                const customMonsters = getCustomMonsters();
                const customItems = getCustomItems();
                const customSpells = getCustomSpells();
                const allCustom = [...customMonsters.map(m => ({...m, type: 'Monster'})), ...customItems.map(i => ({...i, type: 'Item'})), ...customSpells.map(s => ({...s, type: 'Spell'}))];
                const item = allCustom[index];
                if (item.type === 'Monster') {
                    await handleMonsterClick(item);
                } else {
                    showStats(item);
                }
            } else {
                const customItems = getCustomItems();
                const customSpells = getCustomSpells();
                const allCustom = [...customItems.map(i => ({...i, type: 'Item'})), ...customSpells.map(s => ({...s, type: 'Spell'}))];
                const item = allCustom[index];
                showStats(item);
            }
        }
      });
    });
  };

  input.addEventListener('input', (e) => renderResults(e.target.value));
  if (searchNameOnlyCheckbox) searchNameOnlyCheckbox.addEventListener('change', () => renderResults(input.value));
  if (minCrInput) minCrInput.addEventListener('input', () => renderResults(input.value));
  if (maxCrInput) maxCrInput.addEventListener('input', () => renderResults(input.value));
  
  renderResults(''); // Initial render

  // Selection Listener (Only if OBR is available and we are in UI mode)
  if (OBR.player) {
    const initListener = () => {
        try {
            // Check for itemId in URL params first (context menu open)
            const searchParams = new URLSearchParams(window.location.search);
            const initialItemId = searchParams.get('itemId');

            if (initialItemId) {
                  OBR.scene.items.getItems([initialItemId]).then((items) => {
                      if (items.length > 0) {
                         const item = items[0];
                         // Check for extension items (monsters or items)
                         const isExtensionObj = item && item.metadata && (
                             item.metadata.created_by === 'dnd_extension' || 
                             item.metadata.created_by === 'dnd_extension_item' ||
                             (item.metadata.hp !== undefined && item.metadata.ac !== undefined)
                         );
                         
                         // Check if it's a monster
                         const isMonster = item.metadata && (
                             item.metadata.created_by === 'dnd_extension' || 
                             (item.metadata.hp !== undefined && item.metadata.ac !== undefined)
                         );
                         
                         if (isExtensionObj) {
                            // If it's a monster and not GM, skip
                            if (isMonster && !isGM) {
                                console.log("Player tried to view monster stats, blocked.");
                                return;
                            }
                            
                            const m = item.metadata;
                            // Prefer metadata name, fallback to first line of text
                            const name = m.name || (item.text && item.text.plainText ? item.text.plainText.split('\n')[0] : "Unknown");
                            
                            showStats({
                              name: name,
                              hp: m.hp,
                              ac: m.ac,
                              cr: m.cr,
                              type: m.type,
                              rarity: m.rarity,
                              description: m.description,
                              source: m.source
                            }, item.id);
                         } else {
                             // Feedback if not a valid monster
                             if (item.type === 'IMAGE') {
                                 console.log("Selected item is a raw image (not a monster token). Search for a monster to assign stats.");
                             } else {
                                 console.log("Selected item is not a recognized extension object:", item);
                             }
                         }
                      }
                  });
             } else {
                 // Fallback to checking selection if no specific item ID passed
                 OBR.player.getSelection().then(async (selection) => {
                      if (selection && selection.length === 1) {
                         const items = await OBR.scene.items.getItems(selection);
                         if (items.length > 0) {
                             const item = items[0];
                             const isExtensionObj = item && item.metadata && (
                                 item.metadata.created_by === 'dnd_extension' || 
                                 item.metadata.created_by === 'dnd_extension_item' ||
                                 (item.metadata.hp !== undefined && item.metadata.ac !== undefined)
                             );
                             
                             // Check if it's a monster
                             const isMonster = item.metadata && (
                                 item.metadata.created_by === 'dnd_extension' || 
                                 (item.metadata.hp !== undefined && item.metadata.ac !== undefined)
                             );
                             
                             if (isExtensionObj) {
                                // If it's a monster and not GM, skip
                                if (isMonster && !isGM) {
                                    console.log("Player tried to view monster stats, blocked.");
                                    return;
                                }
                                
                                const m = item.metadata;
                                const name = m.name || (item.text && item.text.plainText ? item.text.plainText.split('\n')[0] : "Unknown");
                                
                                showStats({
                                  name: name,
                                  hp: m.hp,
                                  ac: m.ac,
                                  cr: m.cr,
                                  type: m.type,
                                  rarity: m.rarity,
                                  description: m.description,
                                  source: m.source
                                }, item.id);
                             }
                         }
                      }
                 });
             }

             OBR.player.onChange(async (player) => {
               const selection = player.selection;
               // console.log("Selection change detected:", selection);
               if (selection && selection.length === 1) {
                 // Get the item
                 const items = await OBR.scene.items.getItems(selection);
                 if (items.length > 0) {
                     const item = items[0];
                     const isExtensionObj = item && item.metadata && (
                         item.metadata.created_by === 'dnd_extension' || 
                         item.metadata.created_by === 'dnd_extension_item' ||
                         (item.metadata.hp !== undefined && item.metadata.ac !== undefined)
                     );
                     
                     // Check if it's a monster
                     const isMonster = item.metadata && (
                         item.metadata.created_by === 'dnd_extension' || 
                         (item.metadata.hp !== undefined && item.metadata.ac !== undefined)
                     );
                     
                     if (isExtensionObj) {
                        // If it's a monster and not GM, skip
                        if (isMonster && !isGM) {
                            console.log("Player tried to view monster stats, blocked.");
                            return;
                        }
                        
                        // Show stats for this item
                        const m = item.metadata;
                        const name = m.name || (item.text && item.text.plainText ? item.text.plainText.split('\n')[0] : "Unknown");
                        
                        showStats({
                          name: name,
                          hp: m.hp,
                          ac: m.ac,
                          cr: m.cr,
                          type: m.type,
                          rarity: m.rarity,
                          description: m.description,
                          source: m.source
                        }, item.id);
                     }
                 }
               }
             });
            console.log("OBR Player listener registered.");
        } catch (error) {
            console.warn("OBR Player listener failed to register (not ready). Retrying in 500ms...", error);
            setTimeout(initListener, 500);
        }
    };
    initListener();

    // Sync Item Text Changes to Metadata
    const initItemListener = () => {
        try {
            OBR.scene.items.onChange((items) => {
                for (const item of items) {
                    if (item.metadata && item.metadata.created_by === 'dnd_extension') {
                        const text = item.text.plainText;
                        const hpMatch = text.match(/HP:\s*(\d+)/i);
                        const acMatch = text.match(/AC:\s*(\d+)/i);
                        
                        if (hpMatch || acMatch) {
                            const currentHp = item.metadata.hp;
                            const currentAc = item.metadata.ac;
                            
                            const newHp = hpMatch ? parseInt(hpMatch[1], 10) : currentHp;
                            const newAc = acMatch ? parseInt(acMatch[1], 10) : currentAc;
                            
                            // Only update if values are different to avoid loops
                            if (newHp !== currentHp || newAc !== currentAc) {
                                OBR.scene.items.updateItems([item.id], (updateItems) => {
                                    for (let i of updateItems) {
                                        i.metadata.hp = newHp;
                                        i.metadata.ac = newAc;
                                    }
                                });
                            }
                        }
                    }
                }
            });
            console.log("OBR Scene Items listener registered.");
        } catch (error) {
             console.warn("OBR Scene Items listener failed to register (not ready). Retrying in 500ms...", error);
             setTimeout(initItemListener, 500);
        }
    };
    initItemListener();
  }
}

if (window.self === window.top) {
  // Standalone mode (local dev)
  console.log("Running in standalone mode (no OBR iframe detected).");
  
  // Mock OBR for local testing
  window.OBR = {
    scene: {
      items: {
        addItems: async (items) => {
          console.log("[MOCK OBR] Adding items:", items);
          alert(`[MOCK] Added ${items[0].text.plainText} to scene!`);
          return items;
        },
        getItems: async (ids) => {
           // Mock getting items
           return ids.map(id => ({
             id,
             text: { plainText: "Mock Monster\nHP: 10 AC: 15" },
             metadata: {
               created_by: "dnd_extension",
               hp: 10,
               ac: 15,
               cr: "1/4",
               description: "Mock Description\nSTR 10 DEX 12...",
               source: "Mock Source"
             }
           }));
        },
        updateItems: async (ids, updateFn) => {
            console.log("[MOCK OBR] Updating items:", ids);
            // In a real mock we would maintain state, but here just logging is enough
            // to show the call works.
            const mockItems = ids.map(id => ({
                id,
                text: { plainText: "Mock Monster" },
                metadata: { hp: 10, ac: 15 }
            }));
            updateFn(mockItems);
            console.log("[MOCK OBR] Updated items:", mockItems);
        }
      }
    },
    player: {
      onChange: (callback) => {
        // Mock selection change after 2 seconds
        setTimeout(() => {
          console.log("[MOCK OBR] Simulating selection change...");
          callback({ selection: ["mock-id"] });
        }, 5000);
      }
    }
  };
  
  setup();
} else {
  // Production/Extension mode
  OBR.onReady(async () => {
    await syncWithBackend();
    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.get('mode') === 'popover') {
        // We are inside the popover UI
        setup();
    } else {
        // We are the background script
        try {
            await OBR.tool.create({
                id: 'com.dnd-extension.tool',
                icons: [
                    {
                        icon: ICON_SVG,
                        label: 'Monster Search',
                    },
                ],
                onClick: (context, elementId) => {
                    const storedPos = localStorage.getItem('dnd_extension_popover_pos');
                    const anchorPos = storedPos ? JSON.parse(storedPos) : { left: 200, top: 100 };

                    OBR.popover.open({
                        id: 'dnd-monster-search-popover',
                        url: '/index.html?mode=popover',
                        height: 600,
                        width: 400,
                        anchorReference: "POSITION",
                        anchorPosition: anchorPos
                    });
                },
            });
            console.log("Tool created successfully");
        } catch (e) {
            console.error("Error creating tool:", e);
            // Log full error object if possible
            console.log(JSON.stringify(e));
        }

        try {
            await OBR.contextMenu.create({
                id: 'com.dnd-extension.context-menu',
                icons: [
                    {
                        icon: ICON_SVG,
                        label: 'View Stats & Actions',
                        filter: {
                            min: 1,
                        },
                    },
                ],
                onClick: async (context, elementId) => {
                    const itemId = context.items.length > 0 ? context.items[0].id : null;
                    
                    let extraParams = "";
                    if (itemId) {
                         try {
                             // Fetch full item data to get accurate position
                             const items = await OBR.scene.items.getItems([itemId]);
                             if (items.length > 0 && items[0].position) {
                                 const p = items[0].position;
                                 extraParams = `&spawnX=${p.x}&spawnY=${p.y}`;
                             }
                         } catch (e) {
                             console.warn("Could not fetch item position for spawn context:", e);
                         }
                    }

                    // Add timestamp to force reload/update of the iframe
                    const timestamp = Date.now();
                    const url = itemId 
                        ? `/index.html?mode=popover&itemId=${itemId}${extraParams}&t=${timestamp}` 
                        : `/index.html?mode=popover${extraParams}&t=${timestamp}`;
                    
                    const storedPos = localStorage.getItem('dnd_extension_popover_pos');
                    const anchorPos = storedPos ? JSON.parse(storedPos) : { left: 200, top: 100 };

                    // Force close context menu by clearing selection BEFORE opening popover
                    // This avoids race conditions where focus is trapped in the closing menu
                    if (itemId) {
                         await OBR.player.select([]);
                         // Small delay to let OBR process the selection change and close the menu
                         await new Promise(resolve => setTimeout(resolve, 50));
                    }

                    await OBR.popover.open({
                        id: 'dnd-monster-search-popover',
                        url: url,
                        height: 600,
                        width: 400,
                        anchorReference: "POSITION",
                        anchorPosition: anchorPos
                    });
                },
            });
            console.log("Context menu created successfully");
        } catch (e) {
            console.error("Error creating context menu:", e);
        }

        // Create Tool and Mode for Spawning
        try {
            await OBR.tool.create({
                id: 'com.dnd-extension.spawn-tool',
                icons: [{ icon: ICON_SVG, label: 'Spawn Monster' }],
            });

            await OBR.tool.createMode({
                id: 'com.dnd-extension.spawn-mode',
                icons: [{ icon: ICON_SVG, label: 'Spawn Monster' }],
                onToolClick: async (context, event) => {
                    const p = event.pointerPosition;
                    if (p) {
                         const timestamp = Date.now();
                         const url = `/index.html?mode=popover&spawnX=${p.x}&spawnY=${p.y}&t=${timestamp}`;
                         
                         const storedPos = localStorage.getItem('dnd_extension_popover_pos');
                         const anchorPos = storedPos ? JSON.parse(storedPos) : { left: 200, top: 100 };

                         await OBR.popover.open({
                             id: 'dnd-monster-search-popover',
                             url: url,
                             height: 600,
                             width: 400,
                             anchorReference: "POSITION",
                             anchorPosition: anchorPos
                         });
                    }
                }
            });
            console.log("Spawn Tool created successfully");
        } catch (e) {
            console.error("Error creating spawn tool:", e);
        }

        // Listen for rolls from other players
        OBR.broadcast.onMessage(CHANNEL_ID, (event) => {
            if (event.data) {
                OBR.notification.show(event.data);
            }
        });
        
        console.log("DnD Manager Extension Loaded");
        OBR.notification.show("DnD Manager Extension Loaded");
    }
  });
}
