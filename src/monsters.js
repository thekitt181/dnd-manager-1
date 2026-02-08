export default [
  {
    name: "Cave Spider",
    type: "Beast",
    hp: 15,
    ac: 12,
    lore: "Found in dark caves, spinning webs to catch prey.",
    stats: {
      str: 12, dex: 16, con: 12, int: 3, wis: 10, cha: 4,
      actions: [
        { name: "Bite", desc: "Melee Weapon Attack: +5 to hit, reach 5 ft., one creature. Hit: 6 (1d6 + 3) piercing damage." }
      ]
    },
    image: "https://raw.githubusercontent.com/owlbear-rodeo/owlbear-rodeo/master/public/apple-touch-icon.png" 
  },
  {
    name: "Goblin",
    type: "Humanoid",
    hp: 7,
    ac: 15,
    lore: "Small, malicious creatures often found in caves and abandoned mines.",
    stats: {
      str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8,
      actions: [
        { name: "Scimitar", desc: "Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 5 (1d6 + 2) slashing damage." }
      ]
    },
    image: "https://raw.githubusercontent.com/owlbear-rodeo/owlbear-rodeo/master/public/favicon.ico"
  }
];
