const { searchMonsters, addMonsterToScene } = require('./src/popover');

async function runTest() {
  console.log("Searching for 'cave'...");
  const results = searchMonsters('cave');
  console.log(`Found ${results.length} monsters:`, results.map(m => m.name).join(', '));

  if (results.length > 0) {
    console.log("Attempting to add first result to scene...");
    try {
      await addMonsterToScene(results[0]);
      console.log("TEST PASSED: Monster added without validation error.");
    } catch (e) {
      console.error("TEST FAILED: Validation error occurred.");
      // process.exit(1); 
    }
  } else {
      console.log("No monsters found.");
  }
}

runTest();
