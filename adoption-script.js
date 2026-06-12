const fs = require("fs");
const path = require("path");

const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
const CONFIG_PATH = path.join(__dirname, "files-config.json");
const HISTORY_PATH = path.join(__dirname, "adoption-history.json");
const REPORT_PATH = path.join(__dirname, "docs", "report.json");

const DALTON_KEYS = { components: "IDBzmWEtnNBVSQTixgXWjy" };

// Exact Dalton component family names (from the library)
const DALTON_FAMILIES = [
  "Accordion", "Alert", "Avatar", "Badges", "Breadcrumb", "Button",
  "Calendar", "Calendar v.2", "Cards", "Animations", "Cards I", "Cards II",
  "Checkbox", "Chips", "Comparador", "Controls", "Covers",
  "File uploader", "Footer", "Header", "Hero", "Infografia", "Input",
  "Links", "Loader", "Main Search", "Modals", "Pagination", "Progress bar",
  "Radio", "Select", "Sidebar", "Status Message", "Stepper", "Tab",
  "Table", "Text Area", "Toggle", "Tooltips", "Tracking", "Whatsapp float",
];

// Lowercase for case-insensitive matching
const DALTON_FAMILIES_LOWER = DALTON_FAMILIES.map(f => f.toLowerCase());

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

// Check if a component name matches a Dalton family
// Handles: "Button/Primary/Large", "Desktop/Botón Primario", "radio_form", etc.
function isDaltonComponent(name) {
  if (!name) return false;
  const lower = name.toLowerCase();

  // Icons: names starting with "glyphs/"
  if (lower.startsWith("glyphs/")) {
    return { matched: true, family: "Icons" };
  }

  // Check if any segment of the name matches a Dalton family
  const segments = lower.split("/").map(s => s.trim());

  for (const segment of segments) {
    for (const family of DALTON_FAMILIES_LOWER) {
      if (segment === family || segment.startsWith(family + " ") || segment.startsWith(family + "_")) {
        return { matched: true, family: DALTON_FAMILIES[DALTON_FAMILIES_LOWER.indexOf(family)] };
      }
    }
  }

  // Also check full name starts with family
  for (const family of DALTON_FAMILIES_LOWER) {
    if (lower.startsWith(family)) {
      return { matched: true, family: DALTON_FAMILIES[DALTON_FAMILIES_LOWER.indexOf(family)] };
    }
  }

  return { matched: false, family: null };
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

function countInstances(node, counts, usedFamilies, nonDsNames) {
  if (!node) return;

  if (node.type === "INSTANCE") {
    const result = isDaltonComponent(node.name);

    if (result.matched) {
      counts.ds++;
      usedFamilies.add(result.family);
    } else {
      counts.nonDs++;
      const cleanName = (node.name || "Sin nombre").split("/").pop().trim();
      nonDsNames[cleanName] = (nonDsNames[cleanName] || 0) + 1;
    }
  }

  if (node.children) {
    for (const child of node.children) {
      countInstances(child, counts, usedFamilies, nonDsNames);
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

async function analyzeFile(fileKey, fileName) {
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
      countInstances(rfdNode, counts, usedFamilies, nonDsNames);
    }
    await sleep(800);
  }

  const totalInstances = counts.ds + counts.nonDs;
  const adoptionRate = totalInstances > 0 ? Math.round((counts.ds / totalInstances) * 100) : 0;
  const uniqueUsed = usedFamilies.size;
  const totalFamilies = DALTON_FAMILIES.length;
  const coverageRate = Math.round((uniqueUsed / totalFamilies) * 100);

  const top20NonDs = Object.entries(nonDsNames)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }));

  console.log(`  RFD: ${rfdFrameCount} | DS: ${counts.ds} | Non-DS: ${counts.nonDs} | Adoption: ${adoptionRate}% | Coverage: ${uniqueUsed}/${totalFamilies} (${coverageRate}%)`);

  const totalFamiliesWithIcons = DALTON_FAMILIES.length + 1;
  const coverageRateFinal = Math.round((uniqueUsed / totalFamiliesWithIcons) * 100);

  return {
    key: fileKey, name: fileName, rfdFrameCount,
    dsInstances: counts.ds, nonDsInstances: counts.nonDs,
    totalInstances, adoptionRate,
    uniqueComponentsUsed: uniqueUsed,
    totalUniqueInLibrary: totalFamiliesWithIcons,
    coverageRate: coverageRateFinal,
    usedFamiliesList: [...usedFamilies],
    top20NonDs,
  };
}

async function run() {
  if (!FIGMA_TOKEN) { console.error("ERROR: FIGMA_TOKEN not set"); process.exit(1); }

  console.log("=== Dalton DS Adoption Report ===");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Matching against ${DALTON_FAMILIES.length} Dalton component families\n`);

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  let history = [];
  if (fs.existsSync(HISTORY_PATH)) history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));

  const teamsData = [];

  for (const team of config.teams) {
    console.log(`\nTeam: ${team.name}`);
    const filesData = [];

    for (const file of team.files) {
      try {
        filesData.push(await analyzeFile(file.key, file.name));
      } catch (e) {
        console.error(`  Error: ${file.name}:`, e.message);
        filesData.push({ key: file.key, name: file.name, error: e.message, rfdFrameCount: 0, dsInstances: 0, nonDsInstances: 0, totalInstances: 0, adoptionRate: 0, uniqueComponentsUsed: 0, totalUniqueInLibrary: DALTON_FAMILIES.length, coverageRate: 0, top20NonDs: [] });
      }
      await sleep(1500);
    }

    const totalRfdFrames = filesData.reduce((s, f) => s + f.rfdFrameCount, 0);
    const totalDs = filesData.reduce((s, f) => s + f.dsInstances, 0);
    const totalNonDs = filesData.reduce((s, f) => s + f.nonDsInstances, 0);
    const totalInstances = totalDs + totalNonDs;
    const teamAdoptionRate = totalInstances > 0 ? Math.round((totalDs / totalInstances) * 100) : 0;
    // Deduplicate families across files using the stored usedFamiliesList
    const teamFamiliesSet = new Set();
    for (const f of filesData) {
      for (const fam of (f.usedFamiliesList || [])) teamFamiliesSet.add(fam);
    }
    const teamUniqueUsed = teamFamiliesSet.size;
    const totalFamiliesWithIcons = DALTON_FAMILIES.length + 1; // +1 for Icons
    const teamCoverageRate = Math.round((teamUniqueUsed / totalFamiliesWithIcons) * 100);

    const aggregatedNonDs = {};
    for (const f of filesData) {
      for (const { name, count } of (f.top20NonDs || [])) {
        aggregatedNonDs[name] = (aggregatedNonDs[name] || 0) + count;
      }
    }
    const teamTop20NonDs = Object.entries(aggregatedNonDs)
      .sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([name, count]) => ({ name, count }));

    teamsData.push({
      name: team.name, adoptionRate: teamAdoptionRate,
      totalRfdFrames, totalDs, totalNonDs, totalInstances,
      uniqueComponentsUsed: teamUniqueUsed,
      totalUniqueInLibrary: totalFamiliesWithIcons,
      coverageRate: teamCoverageRate, top20NonDs: teamTop20NonDs, files: filesData,
    });
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
  const report = { generatedAt: now.toISOString(), quarter, totalUniqueInLibrary: DALTON_FAMILIES.length + 1, teams: teamsData, history };
  if (!fs.existsSync(path.join(__dirname, "docs"))) fs.mkdirSync(path.join(__dirname, "docs"));
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log(`\nReport saved to docs/report.json`);
  console.log("\n=== Summary ===");
  for (const team of teamsData) {
    console.log(`${team.name}: ${team.adoptionRate}% adoption | ${team.coverageRate}% coverage (${team.uniqueComponentsUsed}/${DALTON_FAMILIES.length})`);
  }
}

run().catch((e) => { console.error("Fatal error:", e); process.exit(1); });
