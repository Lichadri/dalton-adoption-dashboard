const fs = require("fs");
const path = require("path");

const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
const CONFIG_PATH = path.join(__dirname, "files-config.json");
const HISTORY_PATH = path.join(__dirname, "adoption-history.json");
const REPORT_PATH = path.join(__dirname, "docs", "report.json");

const DALTON_KEYS = { components: "IDBzmWEtnNBVSQTixgXWjy" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function figmaFetch(endpoint) {
  const res = await fetch(`https://api.figma.com/v1${endpoint}`, {
    headers: { "X-Figma-Token": FIGMA_TOKEN },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Figma API error ${res.status}: ${err}`);
  }
  return res.json();
}

// Load Dalton data:
// - keys: Set of component keys (for instance matching)
// - keyToFamily: componentKey -> family name (for coverage)
// - totalUniqueFamilies: count of unique component families
async function getDaltonComponentData() {
  const keys = new Set();
  const keyToFamily = new Map();
  const familyNames = new Set();

  try {
    const data = await figmaFetch(`/files/${DALTON_KEYS.components}`);

    // Build componentSet name map: setId -> name
    const setIdToName = new Map();
    if (data.componentSets) {
      for (const [id, cs] of Object.entries(data.componentSets)) {
        setIdToName.set(id, cs.name);
      }
    }

    if (data.components) {
      for (const [id, comp] of Object.entries(data.components)) {
        if (!comp.key) continue;
        keys.add(comp.key);

        // Determine family name
        let familyName;
        if (comp.componentSetId && setIdToName.has(comp.componentSetId)) {
          familyName = setIdToName.get(comp.componentSetId);
        } else {
          // Standalone component (no variants)
          familyName = comp.name;
        }
        keyToFamily.set(comp.key, familyName);
        familyNames.add(familyName);
      }
    }

    console.log(`  Loaded ${keys.size} keys across ${familyNames.size} unique families`);
  } catch (e) {
    console.warn("  Could not load Dalton component keys:", e.message);
  }

  return { keys, keyToFamily, totalUniqueFamilies: familyNames.size };
}

function findReadyForDevNodes(node, found = []) {
  if (!node) return found;
  if (node.devStatus && node.devStatus.type === "READY_FOR_DEV") {
    found.push(node.id);
    return found;
  }
  if (node.children) {
    for (const child of node.children) findReadyForDevNodes(child, found);
  }
  return found;
}

function findNodeById(node, targetId) {
  if (!node) return null;
  if (node.id === targetId) return node;
  if (node.children) {
    for (const child of node.children) {
      const found = findNodeById(child, targetId);
      if (found) return found;
    }
  }
  return null;
}

// Count DS vs non-DS instances
// - usedFamilies: tracks which Dalton families are actually used (for coverage)
// - nonDsNames: frequency map of non-DS component names
function countInstances(node, daltonData, counts, usedFamilies, nonDsNames) {
  if (!node) return;

  if (node.type === "INSTANCE") {
    const compKey = node.componentId; // this is the component KEY in team files
    const isDalton = compKey && daltonData.keys.has(compKey);

    if (isDalton) {
      counts.ds++;
      const family = daltonData.keyToFamily.get(compKey);
      if (family) usedFamilies.add(family);
    } else {
      counts.nonDs++;
      const cleanName = (node.name || "Sin nombre").split("/").pop().trim();
      nonDsNames[cleanName] = (nonDsNames[cleanName] || 0) + 1;
    }
  }

  if (node.children) {
    for (const child of node.children) {
      countInstances(child, daltonData, counts, usedFamilies, nonDsNames);
    }
  }
}

async function getPages(fileKey) {
  const data = await figmaFetch(`/files/${fileKey}?depth=1`);
  return (data.document?.children || []).filter((p) => p.type === "CANVAS");
}

async function getPageNodes(fileKey, pageId) {
  try {
    const data = await figmaFetch(`/files/${fileKey}/nodes?ids=${pageId}&depth=10`);
    return data.nodes?.[pageId]?.document || null;
  } catch (e) {
    console.warn(`  Error fetching page ${pageId}:`, e.message);
    return null;
  }
}

async function analyzeFile(fileKey, fileName, daltonData) {
  console.log(`\n  Analyzing: ${fileName} (${fileKey})`);
  let rfdFrameCount = 0;
  const counts = { ds: 0, nonDs: 0 };
  const usedFamilies = new Set();
  const nonDsNames = {};

  const pages = await getPages(fileKey);
  console.log(`  Pages found: ${pages.length}`);
  await sleep(800);

  for (const page of pages) {
    if (page.editorType === "figjam") continue;
    const pageNode = await getPageNodes(fileKey, page.id);
    if (!pageNode) continue;

    const rfdInPage = findReadyForDevNodes(pageNode);
    console.log(`    Page "${page.name}": ${rfdInPage.length} RFD nodes`);

    for (const nodeId of rfdInPage) {
      const rfdNode = findNodeById(pageNode, nodeId);
      if (!rfdNode) continue;
      rfdFrameCount++;
      countInstances(rfdNode, daltonData, counts, usedFamilies, nonDsNames);
    }
    await sleep(800);
  }

  const totalInstances = counts.ds + counts.nonDs;
  const adoptionRate = totalInstances > 0 ? Math.round((counts.ds / totalInstances) * 100) : 0;
  const uniqueUsed = usedFamilies.size;
  const coverageRate = daltonData.totalUniqueFamilies > 0 ? Math.round((uniqueUsed / daltonData.totalUniqueFamilies) * 100) : 0;

  const top20NonDs = Object.entries(nonDsNames)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }));

  console.log(`  RFD: ${rfdFrameCount} | DS: ${counts.ds} | Non-DS: ${counts.nonDs} | Adoption: ${adoptionRate}% | Coverage: ${uniqueUsed}/${daltonData.totalUniqueFamilies} (${coverageRate}%)`);

  return {
    key: fileKey, name: fileName, rfdFrameCount,
    dsInstances: counts.ds, nonDsInstances: counts.nonDs,
    totalInstances, adoptionRate,
    uniqueComponentsUsed: uniqueUsed,
    totalUniqueInLibrary: daltonData.totalUniqueFamilies,
    coverageRate, top20NonDs,
  };
}

async function run() {
  if (!FIGMA_TOKEN) { console.error("ERROR: FIGMA_TOKEN not set"); process.exit(1); }

  console.log("=== Dalton DS Adoption Report ===");
  console.log(`Date: ${new Date().toISOString()}\n`);

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  let history = [];
  if (fs.existsSync(HISTORY_PATH)) history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));

  console.log("Loading Dalton component data...");
  const daltonData = await getDaltonComponentData();
  await sleep(1000);

  const teamsData = [];

  for (const team of config.teams) {
    console.log(`\nTeam: ${team.name}`);
    const filesData = [];

    for (const file of team.files) {
      try {
        filesData.push(await analyzeFile(file.key, file.name, daltonData));
      } catch (e) {
        console.error(`  Error: ${file.name}:`, e.message);
        filesData.push({ key: file.key, name: file.name, error: e.message, rfdFrameCount: 0, dsInstances: 0, nonDsInstances: 0, totalInstances: 0, adoptionRate: 0, uniqueComponentsUsed: 0, totalUniqueInLibrary: daltonData.totalUniqueFamilies, coverageRate: 0, top20NonDs: [] });
      }
      await sleep(1500);
    }

    const totalRfdFrames = filesData.reduce((s, f) => s + f.rfdFrameCount, 0);
    const totalDs = filesData.reduce((s, f) => s + f.dsInstances, 0);
    const totalNonDs = filesData.reduce((s, f) => s + f.nonDsInstances, 0);
    const totalInstances = totalDs + totalNonDs;
    const teamAdoptionRate = totalInstances > 0 ? Math.round((totalDs / totalInstances) * 100) : 0;
    const teamUniqueUsed = filesData.reduce((s, f) => s + (f.uniqueComponentsUsed || 0), 0);
    const teamCoverageRate = daltonData.totalUniqueFamilies > 0 ? Math.round((teamUniqueUsed / daltonData.totalUniqueFamilies) * 100) : 0;

    const aggregatedNonDs = {};
    for (const f of filesData) {
      for (const { name, count } of (f.top20NonDs || [])) {
        aggregatedNonDs[name] = (aggregatedNonDs[name] || 0) + count;
      }
    }
    const teamTop20NonDs = Object.entries(aggregatedNonDs).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => ({ name, count }));

    teamsData.push({ name: team.name, adoptionRate: teamAdoptionRate, totalRfdFrames, totalDs, totalNonDs, totalInstances, uniqueComponentsUsed: teamUniqueUsed, totalUniqueInLibrary: daltonData.totalUniqueFamilies, coverageRate: teamCoverageRate, top20NonDs: teamTop20NonDs, files: filesData });
  }

  const now = new Date();
  const quarter = `Q${Math.ceil((now.getMonth() + 1) / 3)} ${now.getFullYear()}`;
  const dateStr = now.toISOString().split("T")[0];

  for (const team of teamsData) {
    const existingIdx = history.findIndex((h) => h.team === team.name && h.quarter === quarter);
    const entry = { team: team.name, quarter, date: dateStr, adoptionRate: team.adoptionRate, totalRfdFrames: team.totalRfdFrames, totalDs: team.totalDs, totalInstances: team.totalInstances, coverageRate: team.coverageRate, uniqueComponentsUsed: team.uniqueComponentsUsed };
    if (existingIdx >= 0) { history[existingIdx] = entry; } else { history.push(entry); }
  }

  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  const report = { generatedAt: now.toISOString(), quarter, totalUniqueInLibrary: daltonData.totalUniqueFamilies, teams: teamsData, history };
  if (!fs.existsSync(path.join(__dirname, "docs"))) fs.mkdirSync(path.join(__dirname, "docs"));
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log(`\nReport saved to docs/report.json`);
  console.log("\n=== Summary ===");
  for (const team of teamsData) {
    console.log(`${team.name}: ${team.adoptionRate}% adoption | ${team.coverageRate}% coverage (${team.uniqueComponentsUsed}/${daltonData.totalUniqueFamilies})`);
  }
}

run().catch((e) => { console.error("Fatal error:", e); process.exit(1); });
